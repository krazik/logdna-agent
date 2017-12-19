// This is a port from windows-event-reader @ https://github.com/sedouard/windows-event-reader
// Just needed to make it work for older node versions :)

/* global LogName */
'use strict';
var exec = require('child_process').exec;
var _ = require('lodash');
var debug = require('debug')('winevent');

/**
 * A wrapper for the Get-WinEvent powershell cmdlet for
 * EventLog events for Windows. Emits log messages with a
 * 'event emitter'-like interface.
 */
var WinEventReader = function(options) {
    var defaultOptions = {
        providers: ['Microsoft-Windows-DNS-Client']
        , maxEvents: 100
        // default is the cutoff time is now
        , endTime: new Date(Date.now())
        // default starting time is now
        , startTime: new Date(Date.now())
        , frequency: 10000 // miliseconds
    };
    this.options = _.merge({}, defaultOptions, options);
    this.subscribers = {
        data: []
        , end: []
        , error: []
    };
}

WinEventReader.prototype = {
    on: function(eventName, cb) {
        if (typeof cb !== 'function') {
            throw new Error('Must provide a function callback');
        }
        switch (eventName) {
            case 'data':
                this.subscribers.data.push(cb);
                break;
            case 'end':
                this.subscribers.end.push(cb);
                break;
            case 'end':
                this.subscribers.error.push(cb);
                break;
        }
    }

    , _processLogEvent: function(event) {
        // this field looks like: /Date(1455657195651)/. We're parsing out the epoch time
        var createdAtMilis = event.TimeCreated.replace(/\//g, '').replace('Date(', '').replace(')', '');
        createdAtMilis = parseInt(createdAtMilis);
        // variable naming from powershell will be .NET convention
        // we also don't need to provide all the object fields
        return {
            id: event.Id
            , providerName: event.ProviderName
            , providerId: event.ProviderId
            , logName: event.LogName
            , processId: event.ProcessId
            , threadId: event.threadId
            , machineName: event.MachineName
            , timeCreated: new Date(createdAtMilis)
            , levelDisplayName: event.LevelDisplayName
            , message: event.Message
        };
    }

    , _parseLogData: function(data) {
        var events;
        try {
            events = JSON.parse(data);
        } catch (e) {
            debug('Failed to parse json output:');
            debug(data);
            throw e;
        }

        var processedEvents = [];
        if (!Array.isArray(events)) {
            var event = events;
            processedEvents.push(this._processLogEvent(event));
        } else {
            events.forEach(function(event) {
                processedEvents.push(this._processLogEvent(event));
            });
        }

        return processedEvents;
    }

    , _powershellDate: function(date) {
        var parts = date.toString().split(' ');
        // parses out the first 5 things
        // Wed Feb 17 2016 19:08:14 GMT-0800 (Pacific Standard Time)
        return parts[0] + ' ' + parts[1] + ' ' + parts[2] + ' ' + parts[3] + ' ' + parts[4];
    }

    /**
     * Starts checking providers at specified frequency
     * when any new messages happen, the 'data' event will
     * fire.
     */
    , start: function() {
        setTimeout(function() {
            var providers = '';
            this.options.providers.forEach(function(provider, index) {
                debug('index: ' + index);
                if (index === 0 && this.options.providers.length === 1) {
                    providers += provider;
                    return;
                } else if (index === 0 && this.options.providers.length > 1) {
                    providers += provider + ', ';
                    return;
                } else if (index === this.options.providers.length - 1) {
                    providers += ' ' + provider;
                    return;
                }
                providers += ' ' + provider + ',';
            });

            // will output json
            var powershellCmd = 'powershell "Get-WinEvent -FilterHashTable @{ProviderName=\'' +
                providers + '\'; StartTime=\'' + this._powershellDate(this.options.startTime) +
                '\'; EndTime=\'' + this._powershellDate(this.options.endTime) +
                '\'; } -MaxEvents ' + this.options.maxEvents + ' | ConvertTo-Json"';
            debug(powershellCmd);
            this.powershell = exec(powershellCmd);
            var eventRawData = '';
            this.powershell.stdout.on('data', function(data) {
                eventRawData += data;
            });
            this.powershell.stderr.on('data', function(error) {
                this.subscribers.error.forEach(function(subscriber) {
                    subscriber.call(this, error);
                });
            });
            this.powershell.stderr.on('data', function(error) {
                this.subscribers.error.forEach(function(subscriber) {
                    subscriber.call(this, error);
                });
            });
            this.powershell.on('close', function(code) {
                if (eventRawData) {
                    var logData = this._parseLogData(eventRawData);
                    this.subscribers.data.forEach(function(subscriber) {
                        subscriber.call(this, logData);
                    });
                }

                if (this._stop) {
                    return;
                }
                // iterate loop, starting from now to the next frequency time
                this.options.startTime = new Date(Date.now());
                this.options.endTime = new Date(Date.now() + this.options.frequency);
                this.start();
            });
        }, this.options.frequency);
    }

    /**
     * Stops checking for new events. When this is called
     * the 'end' event will fire signaling the stop of the
     * reader. After this no 'data' events will fire.
     */
    , stop: function() {
        this._stop = true;
        this.powershell.kill();
        this.subscribers.end.forEach(function(subscriber) {
            subscriber.call(this);
        });
    }
};

module.exports = WinEventReader;
