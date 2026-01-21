const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
const UserAgent = require('user-agents');

const app = express();
const PORT = process.env.PORT || 3000;

// ====================
// Configuration
// ====================
const config = {
  // LinkedIn specific
  LINKEDIN_BASE_URL: 'https://www.linkedin.com',
  JOBS_SEARCH_URL: 'https://www.linkedin.com/jobs/search',
  
  // API settings
  CACHE_TTL: 1800, // 30 minutes cache
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 30000, // 30 seconds
  
  // Rate limiting
  RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 minutes
  RATE_LIMIT_MAX: 100, // requests per window
};

// ====================
// Middleware
// ====================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));

app.use(cors({
  origin: [
    'https://rapidapi.com',
    'https://*.rapidapi.com',
    'http://localhost:3000',
    'https://*.vercel.app'
  ]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting per API key
const apiKeyRateLimit = new Map();
const rateLimiter = (req, res, next) => {
  const apiKey = req.headers['x-rapidapi-proxy-secret'] || req.headers['x-api-key'] || req.ip;
  
  if (!apiKeyRateLimit.has(apiKey)) {
    apiKeyRateLimit.set(apiKey, {
      count: 0,
      resetTime: Date.now() + config.RATE_LIMIT_WINDOW
    });
  }
  
  const limitInfo = apiKeyRateLimit.get(apiKey);
  
  if (Date.now() > limitInfo.resetTime) {
    limitInfo.count = 0;
    limitInfo.resetTime = Date.now() + config.RATE_LIMIT_WINDOW;
  }
  
  if (limitInfo.count >= config.RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((limitInfo.resetTime - Date.now()) / 1000)
    });
  }
  
  limitInfo.count++;
  next();
};

app.use(rateLimiter);

// Cache setup
const cache = new NodeCache({ stdTTL: config.CACHE_TTL });

// ====================
// Utility Functions
// ====================
class LinkedInScraper {
  constructor() {
    this.userAgents = [];
    for (let i = 0; i < 10; i++) {
      this.userAgents.push(new UserAgent({ deviceCategory: 'desktop' }).toString());
    }
  }

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  getHeaders() {
    return {
      'User-Agent': this.getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    };
  }

  async fetchWithRetry(url, retries = config.MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios.get(url, {
          headers: this.getHeaders(),
          timeout: config.REQUEST_TIMEOUT,
        });
        return response;
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  }

  parseJobElement($, element) {
    const $element = $(element);
    
    return {
      id: $element.attr('data-id') || uuidv4(),
      title: $element.find('.base-search-card__title').text().trim(),
      company: $element.find('.base-search-card__subtitle').text().trim(),
      location: $element.find('.job-search-card__location').text().trim(),
      date: $element.find('time').attr('datetime') || $element.find('time').text().trim(),
      link: $element.find('.base-card__full-link').attr('href') || '',
      companyLink: $element.find('.base-search-card__subtitle a').attr('href') || '',
      companyLogo: $element.find('.artdeco-entity-image').attr('data-delayed-url') || 
                   $element.find('.artdeco-entity-image').attr('src') || '',
      easyApply: $element.find('.simple-job-card__link').length > 0,
      insights: $element.find('.job-search-card__insight').text().trim(),
    };
  }

  async searchJobs(keywords, location = '', page = 1, remote = false) {
    const params = new URLSearchParams({
      keywords: keywords,
      location: location,
      start: (page - 1) * 25,
      ...(remote && { f_WT: 2 }) // Remote filter
    });

    const url = `${config.JOBS_SEARCH_URL}?${params.toString()}`;
    const cacheKey = `jobs:${url}`;

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('Cache hit for:', cacheKey);
      return cached;
    }

    try {
      console.log('Fetching from LinkedIn:', url);
      const response = await this.fetchWithRetry(url);
      const $ = cheerio.load(response.data);
      
      const jobs = [];
      const jobElements = $('.base-card');
      
      jobElements.each((i, element) => {
        if ($(element).hasClass('job-search-card')) {
          const job = this.parseJobElement($, element);
          if (job.title && job.company) {
            jobs.push(job);
          }
        }
      });

      // Extract pagination info
      const totalResults = parseInt($('.results-context-header__job-count').text().replace(/\D/g, '')) || 0;
      const currentPage = parseInt($('.artdeco-pagination__indicator--number.active').text()) || page;

      const result = {
        success: true,
        totalResults,
        currentPage,
        jobsPerPage: 25,
        totalPages: Math.ceil(totalResults / 25),
        jobs: jobs.slice(0, 25), // Limit to 25 jobs per page
        searchParams: {
          keywords,
          location,
          remote,
          page
        },
        timestamp: new Date().toISOString()
      };

      // Cache the result
      cache.set(cacheKey, result);
      return result;

    } catch (error) {
      console.error('Error fetching jobs:', error.message);
      throw new Error(`Failed to fetch jobs: ${error.message}`);
    }
  }

  async getJobDetails(jobId) {
    const cacheKey = `job:${jobId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const url = `https://www.linkedin.com/jobs/view/${jobId}`;
      const response = await this.fetchWithRetry(url);
      const $ = cheerio.load(response.data);

      const jobDetails = {
        id: jobId,
        title: $('.top-card-layout__title').text().trim(),
        company: $('.topcard__org-name-link').text().trim(),
        location: $('.topcard__flavor--bullet').first().text().trim(),
        postedDate: $('.posted-time-ago__text').text().trim(),
        applicants: $('.num-applicants__caption').text().trim(),
        description: $('.description__text').html() || $('.show-more-less-html__markup').html(),
        seniorityLevel: this.extractDetail($, 'Seniority level'),
        employmentType: this.extractDetail($, 'Employment type'),
        jobFunction: this.extractDetail($, 'Job function'),
        industries: this.extractDetail($, 'Industries'),
        skills: this.extractSkills($),
        companyDetails: {
          name: $('.topcard__org-name-link').text().trim(),
          link: $('.topcard__org-name-link').attr('href') || '',
          employees: $('.company-size').text().trim(),
          about: $('.about-us__description').text().trim(),
        },
        link: url,
        timestamp: new Date().toISOString()
      };

      cache.set(cacheKey, jobDetails);
      return jobDetails;

    } catch (error) {
      console.error('Error fetching job details:', error.message);
      throw new Error(`Failed to fetch job details: ${error.message}`);
    }
  }

  extractDetail($, label) {
    return $(`li:contains("${label}")`).find('span').last().text().trim();
  }

  extractSkills($) {
    const skills = [];
    $('.job-details-skill-match-status-list__pill').each((i, element) => {
      skills.push($(element).text().trim());
    });
    return skills;
  }
}

// Initialize scraper
const scraper = new LinkedInScraper();

// ====================
// API Routes
// ====================
app.get('/', (req, res) => {
  res.json({
    name: 'LinkedIn Jobs Scraper API',
    version: '2.0.0',
    status: 'operational',
    endpoints: {
      search: '/api/search?keywords=software+engineer&location=remote&page=1',
      jobDetails: '/api/job/:jobId',
      health: '/api/health'
    },
    documentation: 'Add /docs endpoint for documentation',
    cache: {
      enabled: true,
      ttl: `${config.CACHE_TTL} seconds`
    }
  });
});

// Search jobs endpoint
app.get('/api/search', async (req, res) => {
  try {
    const { 
      keywords = '', 
      location = '', 
      page = 1, 
      remote = false,
      limit = 25
    } = req.query;

    // Validation
    if (!keywords.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Keywords parameter is required'
      });
    }

    if (page < 1 || page > 10) {
      return res.status(400).json({
        success: false,
        error: 'Page must be between 1 and 10'
      });
    }

    const result = await scraper.searchJobs(
      keywords,
      location,
      parseInt(page),
      remote === 'true'
    );

    // Apply limit if specified
    if (limit && parseInt(limit) < result.jobs.length) {
      result.jobs = result.jobs.slice(0, parseInt(limit));
    }

    res.json(result);

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get job details endpoint
app.get('/api/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Job ID is required'
      });
    }

    const jobDetails = await scraper.getJobDetails(jobId);
    
    if (!jobDetails.title) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({
      success: true,
      data: jobDetails
    });

  } catch (error) {
    console.error('Job details error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache: {
      stats: cache.getStats(),
      keys: cache.keys().length
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: ['/api/search', '/api/job/:id', '/api/health']
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    requestId: req.headers['x-request-id'] || uuidv4()
  });
});

// ====================
// Server Startup
// ====================
app.listen(PORT, () => {
  console.log(`
    🚀 LinkedIn Jobs Scraper API is running!
    
    Port: ${PORT}
    Environment: ${process.env.NODE_ENV || 'development'}
    Cache TTL: ${config.CACHE_TTL} seconds
    Rate Limit: ${config.RATE_LIMIT_MAX} requests per 15 minutes
    
    Endpoints:
    - GET /                   : API info
    - GET /api/search         : Search jobs
    - GET /api/job/:jobId     : Get job details
    - GET /api/health         : Health check
  `);
});

module.exports = app;
