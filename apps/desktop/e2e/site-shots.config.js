'use strict';
// Runs only the landing page's app shots (site-shots.capture.js), never part of the normal e2e suite.
const base = require('./playwright.config');

module.exports = { ...base, testMatch: 'site-shots.capture.js', workers: 1, retries: 0, fullyParallel: false, timeout: 240_000, reporter: 'list' };
