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
  
  // Limits
  MAX_PAGE: 10,
  MAX_RESULTS_PER_PAGE: 50,
  DEFAULT_RESULTS_PER_PAGE: 25,
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
      success: false,
      error: 'Too many requests',
      retryAfter: Math.ceil((limitInfo.resetTime - Date.now()) / 1000),
      timestamp: new Date().toISOString()
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
class CompanyEnricher {
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

  async fetchCompanyProfile(companyUrl) {
    if (!companyUrl || !companyUrl.includes('/company/')) {
      return null;
    }

    const cacheKey = `company:${companyUrl}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      let fullUrl = companyUrl;
      if (!companyUrl.startsWith('http')) {
        fullUrl = `${config.LINKEDIN_BASE_URL}${companyUrl}`;
      }

      const response = await axios.get(fullUrl, {
        headers: this.getHeaders(),
        timeout: config.REQUEST_TIMEOUT,
      });

      const $ = cheerio.load(response.data);
      
      const companyInfo = {
        about: this.extractCompanyAbout($),
        employeeCount: this.extractEmployeeCount($),
        headquarters: this.extractHeadquarters($),
        website: this.extractWebsite($),
        industry: this.extractIndustry($),
        founded: this.extractFoundedYear($),
        specialties: this.extractSpecialties($),
      };

      if (companyInfo.about || companyInfo.employeeCount) {
        cache.set(cacheKey, companyInfo);
      }

      return companyInfo;

    } catch (error) {
      console.error('Error fetching company profile:', error.message);
      return null;
    }
  }

  extractCompanyAbout($) {
    const aboutSection = $('section[data-test-id="about-us"]');
    if (aboutSection.length) {
      const text = aboutSection.find('p, div.core-section-container__content').text().trim();
      return text || null;
    }
    
    const selectors = [
      '.about-us__description',
      '.org-about-module__description',
      '.company-about',
      '[data-test-id="about-us"] p'
    ];
    
    for (const selector of selectors) {
      const element = $(selector);
      if (element.length) {
        const text = element.text().trim();
        if (text) return text;
      }
    }
    
    return null;
  }

  extractEmployeeCount($) {
    const selectors = [
      'dt:contains("Company size") + dd',
      'dt:contains("Employees") + dd',
      '.org-page-details__employees',
      '[data-test-id="about-us__size"]'
    ];
    
    for (const selector of selectors) {
      const element = $(selector);
      if (element.length) {
        const text = element.text().trim();
        if (text) return this.cleanEmployeeCount(text);
      }
    }
    
    return null;
  }

  cleanEmployeeCount(text) {
    const match = text.match(/(\d+(?:,\d+)*(?:\.\d+)?)/);
    if (match) {
      return match[0].replace(/,/g, '');
    }
    return text;
  }

  extractHeadquarters($) {
    const locationElement = $('dt:contains("Headquarters") + dd');
    return locationElement.length ? locationElement.text().trim() : null;
  }

  extractWebsite($) {
    const websiteElement = $('dt:contains("Website") + dd a');
    return websiteElement.length ? websiteElement.attr('href') : null;
  }

  extractIndustry($) {
    const industryElement = $('dt:contains("Industry") + dd');
    return industryElement.length ? industryElement.text().trim() : null;
  }

  extractFoundedYear($) {
    const foundedElement = $('dt:contains("Founded") + dd');
    return foundedElement.length ? foundedElement.text().trim() : null;
  }

  extractSpecialties($) {
    const specialtiesElement = $('dt:contains("Specialties") + dd');
    if (specialtiesElement.length) {
      return specialtiesElement.text().trim().split(',').map(s => s.trim()).filter(Boolean);
    }
    return null;
  }
}

class LinkedInScraper {
  constructor() {
    this.userAgents = [];
    this.companyEnricher = new CompanyEnricher();
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

  cleanText(text) {
    if (!text || typeof text !== 'string') return null;
    const cleaned = text.trim().replace(/\s+/g, ' ');
    return cleaned || null;
  }

  htmlToPlainText(html) {
    if (!html) return null;
    
    try {
      const $ = cheerio.load(html);
      $('script, style, noscript, iframe, embed, object').remove();
      
      let text = $.text();
      text = text.replace(/\s+/g, ' ')
                .replace(/\n+/g, '\n')
                .replace(/\t+/g, ' ')
                .trim();
      
      text = text.replace(/\n{3,}/g, '\n\n');
      
      return text || null;
    } catch (error) {
      console.error('Error converting HTML to text:', error);
      return null;
    }
  }

  parseJobElement($, element) {
    const $element = $(element);
    
    const rawTitle = $element.find('.base-search-card__title').text();
    const rawCompany = $element.find('.base-search-card__subtitle').text();
    const rawLocation = $element.find('.job-search-card__location').text();
    const rawDate = $element.find('time').attr('datetime') || $element.find('time').text();
    const rawLink = $element.find('.base-card__full-link').attr('href');
    const rawCompanyLink = $element.find('.base-search-card__subtitle a').attr('href');
    const rawCompanyLogo = $element.find('.artdeco-entity-image').attr('data-delayed-url') || 
                          $element.find('.artdeco-entity-image').attr('src');
    const hasEasyApply = $element.find('.simple-job-card__link').length > 0;
    const rawInsights = $element.find('.job-search-card__insight').text();
    
    return {
      id: $element.attr('data-id') || uuidv4(),
      title: this.cleanText(rawTitle),
      company: this.cleanText(rawCompany),
      location: this.cleanText(rawLocation),
      date: this.cleanText(rawDate),
      link: this.cleanText(rawLink),
      companyLink: this.cleanText(rawCompanyLink),
      companyLogo: this.cleanText(rawCompanyLogo),
      easyApply: hasEasyApply || null,
      insights: this.cleanText(rawInsights),
    };
  }

  async searchJobs(keywords, location = '', page = 1, limit = config.DEFAULT_RESULTS_PER_PAGE, remote = false, enrichCompanies = false) {
    // Validate inputs
    page = Math.min(Math.max(parseInt(page) || 1, 1), config.MAX_PAGE);
    limit = Math.min(Math.max(parseInt(limit) || config.DEFAULT_RESULTS_PER_PAGE, 1), config.MAX_RESULTS_PER_PAGE);
    
    const params = new URLSearchParams({
      keywords: keywords,
      location: location,
      start: (page - 1) * 25,
      ...(remote && { f_WT: 2 })
    });

    const url = `${config.JOBS_SEARCH_URL}?${params.toString()}`;
    const cacheKey = `jobs:${keywords}:${location}:${page}:${limit}:${remote}:${enrichCompanies}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      cached.cacheHit = true;
      return cached;
    }

    try {
      console.log('Fetching from LinkedIn:', url);
      const response = await this.fetchWithRetry(url);
      const $ = cheerio.load(response.data);
      
      let jobs = [];
      const jobElements = $('.base-card');
      
      jobElements.each((i, element) => {
        if ($(element).hasClass('job-search-card')) {
          const job = this.parseJobElement($, element);
          if (job.title && job.company) {
            jobs.push(job);
          }
        }
      });

      // Apply limit
      jobs = jobs.slice(0, limit);

      // Extract pagination info
      const rawTotalResults = $('.results-context-header__job-count').text();
      const totalResults = rawTotalResults ? parseInt(rawTotalResults.replace(/\D/g, '')) : null;
      const rawCurrentPage = $('.artdeco-pagination__indicator--number.active').text();
      const currentPage = rawCurrentPage ? parseInt(rawCurrentPage) : page;

      // Enrich companies if requested
      if (enrichCompanies) {
        jobs = await Promise.all(
          jobs.map(async (job) => {
            if (job.companyLink) {
              const companyInfo = await this.companyEnricher.fetchCompanyProfile(job.companyLink);
              if (companyInfo) {
                job.companyDetails = companyInfo;
              }
            }
            return job;
          })
        );
      }

      const result = {
        success: true,
        totalResults,
        currentPage,
        jobsPerPage: limit,
        totalPages: totalResults ? Math.ceil(totalResults / limit) : null,
        jobs: jobs,
        searchParams: {
          keywords,
          location,
          page,
          limit,
          remote
        },
        timestamp: new Date().toISOString(),
        cacheHit: false
      };

      cache.set(cacheKey, result);
      return result;

    } catch (error) {
      console.error('Error fetching jobs:', error.message);
      throw new Error(`Failed to fetch jobs: ${error.message}`);
    }
  }

  async getJobDetails(jobId, enrichCompany = false) {
    const cacheKey = `job:${jobId}:${enrichCompany}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      cached.cacheHit = true;
      return cached;
    }

    try {
      const url = `https://www.linkedin.com/jobs/view/${jobId}`;
      const response = await this.fetchWithRetry(url);
      const $ = cheerio.load(response.data);

      // Extract job details
      const rawTitle = $('.top-card-layout__title').text();
      const rawCompany = $('.topcard__org-name-link').text();
      const rawLocation = $('.topcard__flavor--bullet').first().text();
      const rawPostedDate = $('.posted-time-ago__text').text();
      const rawApplicants = $('.num-applicants__caption').text();
      const rawDescriptionHtml = $('.description__text').html() || $('.show-more-less-html__markup').html();
      
      const descriptionText = this.htmlToPlainText(rawDescriptionHtml);

      const seniorityLevel = this.extractDetail($, 'Seniority level');
      const employmentType = this.extractDetail($, 'Employment type');
      const jobFunction = this.extractDetail($, 'Job function');
      const industries = this.extractDetail($, 'Industries');
      
      const skills = this.extractSkills($);
      
      const rawCompanyLink = $('.topcard__org-name-link').attr('href');
      const companyLink = this.cleanText(rawCompanyLink);

      const jobDetails = {
        id: jobId,
        title: this.cleanText(rawTitle),
        company: this.cleanText(rawCompany),
        location: this.cleanText(rawLocation),
        postedDate: this.cleanText(rawPostedDate),
        applicants: this.cleanText(rawApplicants),
        description: {
          html: this.cleanText(rawDescriptionHtml),
          text: descriptionText,
          textLength: descriptionText ? descriptionText.length : null
        },
        seniorityLevel,
        employmentType,
        jobFunction,
        industries,
        skills: skills.length > 0 ? skills : null,
        companyLink,
        link: url,
        timestamp: new Date().toISOString(),
        cacheHit: false
      };

      // Enrich company info if requested
      if (enrichCompany && companyLink) {
        const companyInfo = await this.companyEnricher.fetchCompanyProfile(companyLink);
        if (companyInfo) {
          jobDetails.companyDetails = companyInfo;
        }
      }

      cache.set(cacheKey, jobDetails);
      return jobDetails;

    } catch (error) {
      console.error('Error fetching job details:', error.message);
      throw new Error(`Failed to fetch job details: ${error.message}`);
    }
  }

  extractDetail($, label) {
    const element = $(`li:contains("${label}")`);
    if (element.length) {
      const text = element.find('span').last().text().trim();
      return this.cleanText(text);
    }
    return null;
  }

  extractSkills($) {
    const skills = [];
    $('.job-details-skill-match-status-list__pill').each((i, element) => {
      const skill = $(element).text().trim();
      if (skill) {
        skills.push(skill);
      }
    });
    return skills;
  }
}

// Initialize scraper
const scraper = new LinkedInScraper();

// ====================
// API Routes - Professional RESTful Design
// ====================
app.get('/', (req, res) => {
  res.json({
    name: 'LinkedIn Jobs Scraper API',
    version: '2.2.0',
    status: 'operational',
    documentation: 'Professional RESTful API for LinkedIn job data',
    endpoints: {
      search: 'GET /api/search/{keywords}/{location}',
      jobDetails: 'GET /api/job/{jobId}',
      examples: [
        '/api/search/software%20engineer/remote',
        '/api/search/data%20scientist/San%20Francisco',
        '/api/job/3796675744'
      ]
    },
    features: [
      'Clean text descriptions',
      'Structured job data',
      'Null-safe responses',
      'Rate limited',
      'Cached responses'
    ]
  });
});

// Professional RESTful Search Endpoint
app.get('/api/search/:keywords/:location', async (req, res) => {
  try {
    // Decode URL parameters
    const keywords = decodeURIComponent(req.params.keywords || '');
    const location = decodeURIComponent(req.params.location || '');
    
    // Get query parameters with defaults
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || config.DEFAULT_RESULTS_PER_PAGE;
    const remote = req.query.remote === 'true';
    const enrichCompanies = req.query.enrichCompanies === 'true';

    // Validate required parameters
    if (!keywords.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Keywords parameter is required',
        timestamp: new Date().toISOString()
      });
    }

    if (!location.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Location parameter is required',
        timestamp: new Date().toISOString()
      });
    }

    // Validate limits
    if (page < 1 || page > config.MAX_PAGE) {
      return res.status(400).json({
        success: false,
        error: `Page must be between 1 and ${config.MAX_PAGE}`,
        timestamp: new Date().toISOString()
      });
    }

    if (limit < 1 || limit > config.MAX_RESULTS_PER_PAGE) {
      return res.status(400).json({
        success: false,
        error: `Limit must be between 1 and ${config.MAX_RESULTS_PER_PAGE}`,
        timestamp: new Date().toISOString()
      });
    }

    const result = await scraper.searchJobs(
      keywords,
      location,
      page,
      limit,
      remote,
      enrichCompanies
    );

    // Add pagination links for better RESTful design
    const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
    const encodedKeywords = encodeURIComponent(keywords);
    const encodedLocation = encodeURIComponent(location);
    
    result.links = {
      self: `${baseUrl}/search/${encodedKeywords}/${encodedLocation}?page=${page}&limit=${limit}&remote=${remote}`,
      first: `${baseUrl}/search/${encodedKeywords}/${encodedLocation}?page=1&limit=${limit}&remote=${remote}`,
      last: result.totalPages ? 
        `${baseUrl}/search/${encodedKeywords}/${encodedLocation}?page=${result.totalPages}&limit=${limit}&remote=${remote}` : 
        null,
      next: result.totalPages && page < result.totalPages ? 
        `${baseUrl}/search/${encodedKeywords}/${encodedLocation}?page=${page + 1}&limit=${limit}&remote=${remote}` : 
        null,
      prev: page > 1 ? 
        `${baseUrl}/search/${encodedKeywords}/${encodedLocation}?page=${page - 1}&limit=${limit}&remote=${remote}` : 
        null
    };

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

// Professional RESTful Job Details Endpoint
app.get('/api/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { enrichCompany = false } = req.query;
    
    if (!jobId || !jobId.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Job ID is required',
        timestamp: new Date().toISOString()
      });
    }

    // Validate job ID format (should be numeric)
    if (!/^\d+$/.test(jobId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Job ID format. Job ID should be numeric.',
        timestamp: new Date().toISOString()
      });
    }

    const jobDetails = await scraper.getJobDetails(
      jobId, 
      enrichCompany === 'true'
    );
    
    if (!jobDetails.title) {
      return res.status(404).json({
        success: false,
        error: 'Job not found or no longer available',
        timestamp: new Date().toISOString()
      });
    }

    const response = {
      success: true,
      data: jobDetails,
      links: {
        self: `${req.protocol}://${req.get('host')}${req.baseUrl}/job/${jobId}`,
        linkedin: jobDetails.link
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Job details error:', error);
    
    // Provide more specific error messages
    let statusCode = 500;
    let errorMessage = error.message;
    
    if (error.message.includes('404') || error.message.includes('not found')) {
      statusCode = 404;
      errorMessage = 'Job not found or no longer available on LinkedIn';
    } else if (error.message.includes('timeout')) {
      statusCode = 408;
      errorMessage = 'Request timeout. LinkedIn may be rate limiting requests.';
    } else if (error.message.includes('blocked') || error.message.includes('access denied')) {
      statusCode = 403;
      errorMessage = 'Access to LinkedIn blocked. Try again later.';
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      timestamp: new Date().toISOString()
    });
  }
});

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: [
      {
        method: 'GET',
        path: '/api/search/{keywords}/{location}',
        description: 'Search jobs by keywords and location',
        example: '/api/search/software%20engineer/remote'
      },
      {
        method: 'GET',
        path: '/api/job/{jobId}',
        description: 'Get detailed information about a specific job',
        example: '/api/job/3796675744'
      }
    ],
    timestamp: new Date().toISOString()
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    requestId: req.headers['x-request-id'] || uuidv4(),
    timestamp: new Date().toISOString()
  });
});

// ====================
// Server Startup
// ====================
app.listen(PORT, () => {
  console.log(`
    🚀 LinkedIn Jobs Scraper API v2.2.0
    
    Port: ${PORT}
    Environment: ${process.env.NODE_ENV || 'development'}
    
    Professional RESTful Endpoints:
    ✅ GET /api/search/{keywords}/{location}
    ✅ GET /api/job/{jobId}
    
    Configuration:
    • Cache TTL: ${config.CACHE_TTL} seconds
    • Rate Limit: ${config.RATE_LIMIT_MAX} requests per 15 minutes
    • Max Results: ${config.MAX_RESULTS_PER_PAGE} per page
    • Max Pages: ${config.MAX_PAGE}
    
    Examples:
    • http://localhost:${PORT}/api/search/software%20engineer/remote
    • http://localhost:${PORT}/api/search/data%20scientist/San%20Francisco?page=2&limit=30
    • http://localhost:${PORT}/api/job/3796675744
  `);
});

module.exports = app;