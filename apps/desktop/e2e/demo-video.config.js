'use strict';
// Runs only the launch videos (demo-video.capture.js), never part of the normal e2e suite.
const base = require('./playwright.config');

module.exports = { ...base, testMatch: 'demo-video.capture.js', workers: 1, retries: 0, fullyParallel: false, timeout: 900_000, reporter: 'list' };
