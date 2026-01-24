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
  
  // Company enrichment (premium feature)
  ENABLE_COMPANY_ENRICHMENT: true,
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
      // Ensure we have the full URL
      let fullUrl = companyUrl;
      if (!companyUrl.startsWith('http')) {
        fullUrl = `${config.LINKEDIN_BASE_URL}${companyUrl}`;
      }

      const response = await axios.get(fullUrl, {
        headers: this.getHeaders(),
        timeout: config.REQUEST_TIMEOUT,
      });

      const $ = cheerio.load(response.data);
      
      // Extract company information
      const companyInfo = {
        about: this.extractCompanyAbout($),
        employeeCount: this.extractEmployeeCount($),
        headquarters: this.extractHeadquarters($),
        website: this.extractWebsite($),
        industry: this.extractIndustry($),
        founded: this.extractFoundedYear($),
        specialties: this.extractSpecialties($),
      };

      // Only cache if we got some data
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
    
    // Alternative selectors
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
    // Try multiple selectors for employee count
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
    // Extract numbers and format
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

  // Helper to clean text and handle null
  cleanText(text) {
    if (!text || typeof text !== 'string') return null;
    const cleaned = text.trim().replace(/\s+/g, ' ');
    return cleaned || null;
  }

  // Convert HTML to plain text
  htmlToPlainText(html) {
    if (!html) return null;
    
    try {
      const $ = cheerio.load(html);
      
      // Remove script and style elements
      $('script, style, noscript, iframe, embed, object').remove();
      
      // Get text and clean it
      let text = $.text();
      
      // Clean up whitespace
      text = text.replace(/\s+/g, ' ')
                .replace(/\n+/g, '\n')
                .replace(/\t+/g, ' ')
                .trim();
      
      // Remove excessive line breaks
      text = text.replace(/\n{3,}/g, '\n\n');
      
      return text || null;
    } catch (error) {
      console.error('Error converting HTML to text:', error);
      return null;
    }
  }

  parseJobElement($, element) {
    const $element = $(element);
    
    // Get raw values first
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

  async searchJobs(keywords, location = '', page = 1, remote = false, enrichCompanies = false) {
    const params = new URLSearchParams({
      keywords: keywords,
      location: location,
      start: (page - 1) * 25,
      ...(remote && { f_WT: 2 }) // Remote filter
    });

    const url = `${config.JOBS_SEARCH_URL}?${params.toString()}`;
    const cacheKey = `jobs:${url}:${enrichCompanies}`;

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

      // Extract pagination info
      const rawTotalResults = $('.results-context-header__job-count').text();
      const totalResults = rawTotalResults ? parseInt(rawTotalResults.replace(/\D/g, '')) : null;
      const rawCurrentPage = $('.artdeco-pagination__indicator--number.active').text();
      const currentPage = rawCurrentPage ? parseInt(rawCurrentPage) : page;

      // Enrich companies if requested
      if (enrichCompanies && config.ENABLE_COMPANY_ENRICHMENT) {
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
        jobsPerPage: 25,
        totalPages: totalResults ? Math.ceil(totalResults / 25) : null,
        jobs: jobs.slice(0, 25), // Limit to 25 jobs per page
        searchParams: {
          keywords,
          location,
          remote,
          page,
          enrichCompanies
        },
        timestamp: new Date().toISOString(),
        cacheHit: false
      };

      // Cache the result
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
      
      // Get description as plain text
      const descriptionText = this.htmlToPlainText(rawDescriptionHtml);

      // Extract details using improved method
      const seniorityLevel = this.extractDetail($, 'Seniority level');
      const employmentType = this.extractDetail($, 'Employment type');
      const jobFunction = this.extractDetail($, 'Job function');
      const industries = this.extractDetail($, 'Industries');
      
      const skills = this.extractSkills($);
      
      // Get company link
      const rawCompanyLink = $('.topcard__org-name-link').attr('href');
      const companyLink = this.cleanText(rawCompanyLink);

      // Prepare job details object
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
      if (enrichCompany && config.ENABLE_COMPANY_ENRICHMENT && companyLink) {
        const companyInfo = await this.companyEnricher.fetchCompanyProfile(companyLink);
        if (companyInfo) {
          jobDetails.companyDetails = companyInfo;
        }
      }

      // Cache the result
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
// API Routes
// ====================
app.get('/', (req, res) => {
  res.json({
    name: 'LinkedIn Jobs Scraper API',
    version: '2.1.0',
    status: 'operational',
    features: {
      descriptionText: 'Clean text version of job descriptions',
      companyEnrichment: 'Premium company details available',
      nullHandling: 'Empty fields return null instead of empty strings'
    },
    endpoints: {
      search: '/api/search?keywords=software+engineer&location=remote&page=1&enrichCompanies=true',
      jobDetails: '/api/job/:jobId?enrichCompany=true',
      health: '/api/health'
    },
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
      limit = 25,
      enrichCompanies = false
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
      remote === 'true',
      enrichCompanies === 'true'
    );

    // Apply limit if specified
    if (limit && parseInt(limit) < result.jobs.length) {
      result.jobs = result.jobs.slice(0, parseInt(limit));
    }

    // Add premium feature indicator
    if (enrichCompanies === 'true') {
      result.premiumFeature = 'companyEnrichment';
      result.enrichedCompanies = result.jobs.filter(job => job.companyDetails).length;
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
    const { enrichCompany = false } = req.query;
    
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Job ID is required'
      });
    }

    const jobDetails = await scraper.getJobDetails(
      jobId, 
      enrichCompany === 'true'
    );
    
    if (!jobDetails.title) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    const response = {
      success: true,
      data: jobDetails,
      premium: enrichCompany === 'true' && jobDetails.companyDetails ? 'companyEnrichment' : null
    };

    res.json(response);

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
    },
    config: {
      companyEnrichment: config.ENABLE_COMPANY_ENRICHMENT,
      cacheTtl: config.CACHE_TTL,
      rateLimit: config.RATE_LIMIT_MAX
    }
  });
});

// Premium features endpoint
app.get('/api/features', (req, res) => {
  res.json({
    premiumFeatures: [
      {
        name: 'Company Enrichment',
        description: 'Fetches detailed company information including About section, employee count, headquarters, and more',
        endpoint: 'Add ?enrichCompany=true to job details endpoint or ?enrichCompanies=true to search endpoint',
        pricing: 'Premium tier required'
      },
      {
        name: 'Clean Text Descriptions',
        description: 'Provides both HTML and clean plain text versions of job descriptions',
        endpoint: 'Available in all job details responses',
        pricing: 'All tiers'
      },
      {
        name: 'Advanced Null Handling',
        description: 'Empty fields return null instead of empty strings for cleaner API responses',
        endpoint: 'All endpoints',
        pricing: 'All tiers'
      }
    ]
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: [
      '/api/search',
      '/api/job/:id', 
      '/api/health',
      '/api/features'
    ]
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
    🚀 LinkedIn Jobs Scraper API v2.1.0
    
    Port: ${PORT}
    Environment: ${process.env.NODE_ENV || 'development'}
    
    New Features:
    ✅ Clean text descriptions
    ✅ Company enrichment (premium)
    ✅ Null handling for empty fields
    
    Cache TTL: ${config.CACHE_TTL} seconds
    Rate Limit: ${config.RATE_LIMIT_MAX} requests per 15 minutes
    
    Endpoints:
    - GET /                   : API info
    - GET /api/search         : Search jobs (add ?enrichCompanies=true)
    - GET /api/job/:jobId     : Get job details (add ?enrichCompany=true)
    - GET /api/health         : Health check
    - GET /api/features       : Premium features info
  `);
});

module.exports = app;