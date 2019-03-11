var storybookCheck = require('./check');
var path = require('path');
var fs = require('fs');
var os = require('os');
var getPort = require('get-port');
var spawn = require('child_process').spawn;
var request = require('request');
var requestRetry = require('requestretry');
var puppeteer = require('puppeteer');
var colors = require('colors/safe');
var template = require('lodash/template');
var semver = require('semver');
var Promise = require('bluebird');

var storybookObj;

var getStorybook = function(page, tries) {
  var maxTries = 5;
  if (typeof tries === 'undefined') {
    tries = 0;
  }
  return page.evaluate('window.__screener_storybook__()')
    .then(function(result) {
      if (tries < maxTries && (!result || (typeof result === 'object' && result.length === 0))) {
        return Promise.delay(2*1000).then(function() {
          return getStorybook(page, tries + 1);
        });
      }
      if (typeof result === 'object' && result.length > 0) {
        var stepsScript = fs.readFileSync(__dirname + '/scripts/story-steps.js', 'utf8');
        return page.evaluate(stepsScript);
      }
      return result;
    })
    .catch(function() {
      return null;
    });
};

exports.server = function(config, options, callback) {
  var storybookApp;
  var storybookVersion;
  if (!config || !config.storybookConfigDir) {
    return callback(new Error('Error: \'storybookConfigDir\' not found in config file.'));
  }
  if ([2, 3, 4, 5].indexOf(config.storybookVersion) > -1) {
    storybookApp = 'react';
    if (['react', 'vue', 'angular', 'html'].indexOf(config.storybookApp) > -1) {
      storybookApp = config.storybookApp;
    }
    storybookVersion = {
      major: config.storybookVersion,
      full: config.storybookVersion + '.0.0'
    };
  } else {
    // check storybook module
    try {
      var pkg = storybookCheck();
      storybookApp = pkg.app;
      storybookVersion = pkg.version;
    } catch(ex) {
      return callback(ex);
    }
  }
  // find free port
  getPort().then(function(port) {
    // inject temp storybook config file to get storybook
    var configPath = path.resolve(process.cwd(), config.storybookConfigDir, 'config.js');
    if (!fs.existsSync(configPath)) {
      return callback(new Error('Storybook config file not found: ' + configPath));
    }
    var configBody = fs.readFileSync(configPath, 'utf8');
    var templateType = 'default';
    if (storybookVersion.major === 2) {
      templateType = 'v' + storybookVersion.major;
    }
    var codeTemplate = fs.readFileSync(__dirname + '/templates/' + templateType + '.template', 'utf8');
    var code = template(codeTemplate)({ code: configBody, app: storybookApp });
    fs.writeFileSync(configPath, code, 'utf8');

    // start Storybook dev server
    var binPath = path.resolve(process.cwd(), 'node_modules/.bin');
    if (config.storybookBinPath) {
      binPath = config.storybookBinPath;
      console.log('Use custom storybook bin path: ' + binPath);
    }
    var bin = path.resolve(binPath, 'start-storybook');
    var isWin = false;
    if (/^win/.test(process.platform)) {
      isWin = true;
      bin += '.cmd';
    }
    var args = ['--port', port, '--config-dir', config.storybookConfigDir];
    if (config.storybookStaticDir) {
      args.push('--static-dir');
      args.push(config.storybookStaticDir);
    }
    // support storybook v4+ `--ci` flag starting from v4.0.0-alpha.23
    if (storybookVersion.major >= 4 && semver.gt(storybookVersion.full, '4.0.0-alpha.22')) {
      args.push('--ci');
    }
    console.log('\nStarting Storybook server...');
    console.log('>', 'start-storybook', args.join(' '), '\n\nPlease wait. Starting Storybook may take a minute...\n');
    var serverProcess = spawn(bin, args, {detached: !isWin});
    if (options && (options.debug || options.serverOnly)) {
      serverProcess.stdout.on('data', function(data) { console.log(data.toString('utf8').trim()); });
      serverProcess.stderr.on('data', function(data) { console.error(data.toString('utf8').trim()); });
    }

    // clean-up all child processes when this process is terminated
    process.on('exit', function() {
      if (fs.readFileSync(configPath, 'utf8') !== configBody) {
        fs.writeFileSync(configPath, configBody, 'utf8');
      }
      if (!isWin) {
        process.kill(-serverProcess.pid);
      }
    });
    process.on('SIGINT', function() {
      process.exit();
    });
    process.on('uncaughtException', function(err) {
      console.error(err);
      process.exit(1);
    });

    // wait for storybook server to be ready
    setTimeout(function() {
      var baseUrl = 'http://localhost:' + port;
      var retryStrategy = function(err, response) {
        return requestRetry.RetryStrategies.HTTPOrNetworkError(err, response) || (response && response.statusCode === 404);
      };
      requestRetry.get(baseUrl + '/', {retryStrategy: retryStrategy, maxAttempts: 60}, function(err, response, body) {
        if (err) return callback(err);
        if (response.statusCode != 200 || !body) {
          return callback(new Error('Error loading Storybook'));
        }
        var previewRoute = '/preview.html';
        // confirm existence of preview.html, or fallback to iframe.html
        request.get(baseUrl + previewRoute, function(err, response) {
          if (err) return callback(err);
          if (response.statusCode != 200) {
            previewRoute = '/iframe.html';
          }
          // get storybook obj with puppeteer
          var launchOptions = {headless: true};
          if (os.platform() === 'linux') {
            launchOptions.args = ['--no-sandbox'];
          }
          var browser, page;
          var done = function() {
            try {
              // reset config file to original code
              fs.writeFileSync(configPath, configBody, 'utf8');
            } catch(ex) {
              return callback(ex);
            }
            callback(null, {port: port, preview: previewRoute});
          };
          puppeteer.launch(launchOptions)
            .then(function(_browser) {
              browser = _browser;
              return browser.newPage();
            })
            .then(function(_page) {
              page = _page;
              return page.goto(baseUrl + previewRoute);
            })
            .then(function() {
              return getStorybook(page);
            })
            .then(function(result) {
              storybookObj = result;
              return browser.close();
            })
            .then(done)
            .catch(function(ex) {
              if (options && options.debug) {
                console.error(ex);
              }
              if (browser) {
                return browser.close().then(done);
              }
              done();
            });
        });
      });
    }, 3*1000);
  }).catch(callback);
};

exports.get = function(options) {
  if (!storybookObj) {
    console.error(colors.red('Error getting Storybook object'));
    if (options && options.debug) {
      console.error(colors.red('Please send debug output to support@screener.io'));
    } else {
      console.error(colors.red('Please re-run with --debug flag, and send debug output to support@screener.io'));
    }
    throw new Error('Storybook object not found');
  }
  return storybookObj;
};
