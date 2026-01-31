const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
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
  
  // Results
  DEFAULT_RESULTS: 50, // Return 50 most relevant jobs
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

  // Extract numeric ID from any LinkedIn ID format
  extractNumericId(input) {
    if (!input) return null;
    
    // Try to extract numeric part from various formats
    const str = String(input);
    
    // Case 1: Already numeric
    if (/^\d+$/.test(str)) {
      return str;
    }
    
    // Case 2: Extract numeric part from alphanumeric
    const numericMatch = str.match(/(\d+)/);
    if (numericMatch && numericMatch[1]) {
      return numericMatch[1];
    }
    
    // Case 3: Extract from URL patterns
    const urlPatterns = [
      /jobs\/view\/(\d+)/,
      /jobId=(\d+)/,
      /id=(\d+)/,
      /-(\d+)\//,
    ];
    
    for (const pattern of urlPatterns) {
      const match = str.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    // Case 4: No numeric ID found, generate a fallback numeric ID
    // Convert UUID to numeric string (first 10 digits of hash)
    const fallbackId = Math.abs(this.stringToHash(str)).toString().substring(0, 10);
    return fallbackId;
  }
  
  // Helper to generate consistent numeric hash from string
  stringToHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
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
      
      // Remove unwanted elements
      $('script, style, noscript, iframe, embed, object, header, footer, nav').remove();
      
      // Get text content
      let text = $.text();
      
      // Clean up the text
      text = text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .replace(/\t+/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
      
      // Remove excessive line breaks and normalize
      text = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n\n');
      
      // Remove common LinkedIn-specific clutter
      const clutterPatterns = [
        /See who you know at.*$/m,
        /Promoted|Sponsored/g,
        /^[•\-*]\s*/gm,
        /\s*…\s*See more\s*/g,
      ];
      
      clutterPatterns.forEach(pattern => {
        text = text.replace(pattern, '');
      });
      
      // Clean up any remaining artifacts
      text = text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+|\s+$/g, '')
        .replace(/(\n\s*){2,}/g, '\n\n');
      
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
    
    // Clean company link to remove tracking parameters
    let cleanedCompanyLink = this.cleanText(rawCompanyLink);
    if (cleanedCompanyLink && cleanedCompanyLink.includes('?')) {
      cleanedCompanyLink = cleanedCompanyLink.split('?')[0];
    }
    
    // Ensure LinkedIn links are complete
    let jobLink = this.cleanText(rawLink);
    if (jobLink && !jobLink.startsWith('http')) {
      jobLink = `https://www.linkedin.com${jobLink}`;
    }
    
    // Extract consistent numeric ID
    const rawId = $element.attr('data-id') || jobLink || uuidv4();
    const numericId = this.extractNumericId(rawId);
    
    return {
      id: numericId, // Always numeric ID
      title: this.cleanText(rawTitle),
      company: this.cleanText(rawCompany),
      location: this.cleanText(rawLocation),
      date: this.cleanText(rawDate),
      link: jobLink,
      companyLink: cleanedCompanyLink,
      companyLogo: this.cleanText(rawCompanyLogo),
      easyApply: hasEasyApply || null,
      insights: this.cleanText(rawInsights),
    };
  }

  async searchJobs(keywords, location = '', remote = false, enrichCompanies = false) {
    // Always get 50 most relevant jobs (no pagination)
    const params = new URLSearchParams({
      keywords: keywords,
      location: location,
      start: 0, // Always get first 50 most relevant jobs
      ...(remote && { f_WT: 2 })
    });

    const url = `${config.JOBS_SEARCH_URL}?${params.toString()}`;
    const cacheKey = `jobs:${keywords}:${location}:${remote}:${enrichCompanies}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      cached.cacheHit = true;
      return cached;
    }

    try {
      console.log('Fetching 50 most relevant jobs from LinkedIn:', url);
      const response = await this.fetchWithRetry(url);
      const $ = cheerio.load(response.data);
      
      let jobs = [];
      const jobElements = $('.base-card');
      
      jobElements.each((i, element) => {
        if ($(element).hasClass('job-search-card')) {
          const job = this.parseJobElement($, element);
          if (job.title && job.company && job.id) {
            jobs.push(job);
          }
        }
      });

      // Get exactly 50 jobs (or as many as available)
      jobs = jobs.slice(0, config.DEFAULT_RESULTS);

      // Extract total results for information
      const rawTotalResults = $('.results-context-header__job-count').text();
      const totalResults = rawTotalResults ? parseInt(rawTotalResults.replace(/\D/g, '')) : null;

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
        data: {
          totalAvailableJobs: totalResults,
          jobsReturned: jobs.length,
          jobs: jobs
        },
        searchParams: {
          keywords,
          location,
          remote
        },
        timestamp: new Date().toISOString()
      };

      cache.set(cacheKey, result);
      return result;

    } catch (error) {
      console.error('Error fetching jobs:', error.message);
      throw new Error(`Failed to fetch jobs: ${error.message}`);
    }
  }

  async getJobDetails(jobId, enrichCompany = false) {
    // Ensure jobId is numeric
    const numericJobId = this.extractNumericId(jobId);
    if (!numericJobId) {
      throw new Error('Invalid Job ID. Job ID must contain numeric values.');
    }
    
    const cacheKey = `job:${numericJobId}:${enrichCompany}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      cached.cacheHit = true;
      return cached;
    }

    try {
      const url = `https://www.linkedin.com/jobs/view/${numericJobId}`;
      const response = await this.fetchWithRetry(url);
      const $ = cheerio.load(response.data);

      // Extract job details
      const rawTitle = $('.top-card-layout__title').text();
      const rawCompany = $('.topcard__org-name-link').text();
      const rawLocation = $('.topcard__flavor--bullet').first().text();
      const rawPostedDate = $('.posted-time-ago__text').text();
      const rawApplicants = $('.num-applicants__caption').text();
      const rawDescriptionHtml = $('.description__text').html() || $('.show-more-less-html__markup').html();
      
      // Convert HTML to clean plain text only
      const descriptionText = this.htmlToPlainText(rawDescriptionHtml);

      const seniorityLevel = this.extractDetail($, 'Seniority level');
      const employmentType = this.extractDetail($, 'Employment type');
      const jobFunction = this.extractDetail($, 'Job function');
      const industries = this.extractDetail($, 'Industries');
      
      const skills = this.extractSkills($);
      
      const rawCompanyLink = $('.topcard__org-name-link').attr('href');
      const companyLink = this.cleanText(rawCompanyLink);

      // Extract salary if available
      const salaryInfo = this.extractSalary($);

      const jobDetails = {
        id: numericJobId, // Always numeric
        title: this.cleanText(rawTitle),
        company: this.cleanText(rawCompany),
        location: this.cleanText(rawLocation),
        postedDate: this.cleanText(rawPostedDate),
        applicants: this.cleanText(rawApplicants),
        description: descriptionText,
        descriptionLength: descriptionText ? descriptionText.length : null,
        seniorityLevel,
        employmentType,
        jobFunction,
        industries,
        skills: skills.length > 0 ? skills : null,
        salary: salaryInfo,
        companyLink: companyLink,
        jobLink: url,
        source: 'linkedin',
        timestamp: new Date().toISOString()
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

  extractSalary($) {
    const salaryElement = $('.salary');
    if (salaryElement.length) {
      const salaryText = salaryElement.text().trim();
      if (salaryText) {
        // Try to extract numeric salary ranges
        const matches = salaryText.match(/(\$[\d,]+(?:\.\d{2})?)(?:\s*-\s*\$([\d,]+(?:\.\d{2})?))?/);
        if (matches) {
          return {
            text: salaryText,
            min: matches[1] ? matches[1].replace(/[^\d.]/g, '') : null,
            max: matches[2] ? matches[2].replace(/[^\d.]/g, '') : null,
            currency: 'USD'
          };
        }
        return { text: salaryText };
      }
    }
    return null;
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
    version: '3.2.0',
    status: 'operational',
    description: 'Get LinkedIn jobs with consistent numeric IDs',
    endpoints: [
      {
        method: 'GET',
        path: '/api/search/{keywords}/{location}',
        description: 'Search LinkedIn jobs by keywords and location',
        note: 'Returns jobs with numeric IDs for use with job details endpoint'
      },
      {
        method: 'GET',
        path: '/api/job/{jobId}',
        description: 'Get detailed information about a LinkedIn job',
        note: 'Job ID must be numeric (as returned by search endpoint)'
      }
    ]
  });
});

// Search Jobs Endpoint
app.get('/api/search/:keywords/:location', async (req, res) => {
  try {
    // Decode URL parameters
    const keywords = decodeURIComponent(req.params.keywords || '');
    const location = decodeURIComponent(req.params.location || '');
    
    // Get query parameters
    const remote = req.query.remote === 'true';
    const enrichCompanies = req.query.enrichCompanies === 'true';

    // Validate required parameters
    if (!keywords.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Keywords parameter is required'
      });
    }

    if (!location.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Location parameter is required'
      });
    }

    const result = await scraper.searchJobs(
      keywords,
      location,
      remote,
      enrichCompanies
    );

    // Remove internal indicators
    delete result.cacheHit;
    
    res.json(result);

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Job Details Endpoint
app.get('/api/job/:jobId', async (req, res) => {
  try {
    let { jobId } = req.params;
    const { enrichCompany = false } = req.query;
    
    if (!jobId || !jobId.trim()) {
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
        error: 'Job not found or no longer available'
      });
    }

    // Remove only internal cache indicator
    delete jobDetails.cacheHit;
    
    const response = {
      success: true,
      data: jobDetails
    };

    res.json(response);

  } catch (error) {
    console.error('Job details error:', error);
    
    // Provide more specific error messages
    let statusCode = 500;
    let errorMessage = error.message;
    
    if (error.message.includes('Invalid Job ID') || error.message.includes('must contain numeric')) {
      statusCode = 400;
      errorMessage = 'Job ID must be numeric. Use the numeric IDs returned by the search endpoint.';
    } else if (error.message.includes('404') || error.message.includes('not found')) {
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
      error: errorMessage
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
        description: 'Get LinkedIn jobs by keywords and location',
        example: '/api/search/software%20engineer/remote',
        note: 'Returns jobs with numeric IDs'
      },
      {
        method: 'GET',
        path: '/api/job/{jobId}',
        description: 'Get detailed information about a specific job',
        example: '/api/job/3796675744',
        note: 'Job ID must be numeric'
      }
    ]
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ====================
// Server Startup
// ====================
app.listen(PORT, () => {
  console.log(`
    🚀 LinkedIn Jobs Scraper API v3.2.0
    
    Port: ${PORT}
    Environment: ${process.env.NODE_ENV || 'development'}
    
    Consistent Numeric IDs:
    ✅ Search returns numeric IDs only
    ✅ Job details accepts numeric IDs only
    ✅ All IDs are consistent across endpoints
    
    Simplified API:
    ✅ GET /api/search/{keywords}/{location}
    ✅ GET /api/job/{jobId}
    
    Key Features:
    • 50 most relevant jobs per search
    • Consistent numeric IDs
    • Clean text descriptions
    • No pagination complexity
    
    Configuration:
    • Jobs per search: ${config.DEFAULT_RESULTS}
    • Cache TTL: ${config.CACHE_TTL} seconds
    • Retry attempts: ${config.MAX_RETRIES}
    
    Examples:
    • http://localhost:${PORT}/api/search/software%20engineer/remote
    • http://localhost:${PORT}/api/job/3796675744
    
    Ready for production! 🚀
  `);
});

module.exports = app;