/*
    Latest DX Logs v1.0.1 by AAD
    https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Latest-DX-Logs

    //// Server-side code ////
*/

'use strict';

const pluginName = "DX Log";

const dxSeen = new Map();                       // key --> lastSeen timestamp
const dxConsoleSeen = new Map();                // last logged to console
const dxIndex = new Map();                      // key --> array index
const latestDxLog = [];

// Library imports
const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');

// File imports
const config = require('./../../config.json');
const { logInfo, logWarn, logError } = require('../../server/console');
const endpointsRouter = require('../../server/endpoints');
const ServerName = config.identification.tunerName;

// Define paths
const rootDir = path.dirname(require.main.filename);
const configFolderPath = path.join(rootDir, 'plugins_configs');
const configFileName = 'LatestDXLogs.json';
const configFilePath = path.join(configFolderPath, configFileName);

// const variables
const debug = false;
const webserverPort = config.webserver.webserverPort || 8080;
const externalWsUrl = `ws://127.0.0.1:${webserverPort}`;

// let variables
let isFirstRun = true;
let ipAddress = externalWsUrl;
let TextSocket;
let ipTimeout;
let nodemailer;
let MINIMUM_DX_DISTANCE, MAX_LOG_ENTRIES, DX_HOLD_TIME, DX_CONSOLE_HOLD_TIME, SEND_EMAIL, EMAIL_SERVICE, EMAIL_USER, EMAIL_PASS;

function checkConfigFile() {
    if (!fs.existsSync(configFolderPath)) {
        logInfo(`[${pluginName}] Creating plugins_configs folder...`);
        fs.mkdirSync(configFolderPath, { recursive: true });
    }

    if (!fs.existsSync(configFilePath)) {
        logInfo(`[${pluginName}] Creating default ${configFileName}...`);
        const defaultConfig = {
            "minimumDxDistance": 175,
            "maxLogEntries": 20,
            "dxHoldTime": 5,
            "dxConsoleHoldTime": 60,
            "sendEmail": false,
            "emailServer": "gmail",
            "emailUser": "",
            "emailPass": ""
        };

        // Custom formatting to keep frequency objects on one line
        const formattedJson = JSON.stringify(defaultConfig, null, 4);

        fs.writeFileSync(configFilePath, formattedJson);
    }
}

// Default settings
const defaultSettings = {
    minimumDxDistance: 175,
    maxLogEntries: 20,
    dxHoldTime: 5,
    dxConsoleHoldTime: 60,
    sendEmail: false,
    emailServer: 'gmail',
    emailUser: '',
    emailPass: ''
};

function loadSettings() {
    try {
        const rawData = fs.readFileSync(configFilePath, 'utf8');
        const configData = JSON.parse(rawData);

        // Check for missing settings and add defaults
        let configModified = false;
        for (const key in defaultSettings) {
            if (!(key in configData)) {
                configData[key] = defaultSettings[key];
                configModified = true;
                logInfo(`[${pluginName}] Added missing setting '${key}' with default value`);
            }
        }

        if (configModified) {
            fs.writeFileSync(
                configFilePath,
                JSON.stringify(configData, null, 4),
                'utf8'
            );
            logInfo(`[${pluginName}] ${configFileName} file updated with missing defaults`);
        }

        MINIMUM_DX_DISTANCE = configData.minimumDxDistance ?? 175; // km        // minimum distance required to add an entry
        MAX_LOG_ENTRIES = configData.maxLogEntries ?? 20;                       // last number of DX events to keep
        DX_HOLD_TIME = configData.dxHoldTime ?? 5;                              // minutes to ignore duplicate entry
        DX_CONSOLE_HOLD_TIME = configData.dxConsoleHoldTime ?? 60;              // minutes between duplicate console logs
        SEND_EMAIL = configData.sendEmail ?? false;                             // send email on DX event
        EMAIL_SERVICE = configData.emailServer ?? 'gmail';                      // email service
        EMAIL_USER = configData.emailUser ?? '';                                // email address
        EMAIL_PASS = configData.emailPass ?? '';                                // email password

        logInfo(`[${pluginName}] Minimum distance: ${MINIMUM_DX_DISTANCE} km | Max log entries: ${MAX_LOG_ENTRIES} events | Hold time: ${DX_HOLD_TIME} min | Console hold time: ${DX_CONSOLE_HOLD_TIME} min | Send email: ${SEND_EMAIL}`);

        if (SEND_EMAIL) nodemailer = require('nodemailer');
    } catch (err) {
        logError(`[${pluginName}] Failed to parse ${configFileName}:`, err.message);
        if (SEND_EMAIL && !nodemailer) logError(`[${pluginName}] run "npm install nodemailer"`);
    }
}

function customRouter() {
    endpointsRouter.get('/latest-dx-log-plugin', (req, res) => {
        const pluginHeader = req.get('X-Plugin-Name') || 'NoPlugin';

        if (pluginHeader === 'LatestDxLogPlugin') {
            ipAddress = req.headers['x-forwarded-for']?.split(',')[0]
                        || req.connection.remoteAddress
                        || externalWsUrl;

            clearTimeout(ipTimeout);
            ipTimeout = setTimeout(() => { ipAddress = externalWsUrl; }, 5000);

            res.json({
                serverTime: Date.now(),
                count: latestDxLog.length,
                entries: latestDxLog
            });
        } else {
            res.status(403).json({ error: 'Unauthorised' });
        }
    });

    if (isFirstRun && ipAddress) logInfo(`[${pluginName}] Custom router added to endpoints router (${ipAddress}).`);
}

function upsertDxLog(key, entry) {
    // Remove it from its old position if station already exists
    if (dxIndex.has(key)) {
        const oldIndex = dxIndex.get(key);
        latestDxLog.splice(oldIndex, 1);

        // Rebuild indexes above removed element
        for (const [k, i] of dxIndex) {
            if (i > oldIndex) dxIndex.set(k, i - 1);
        }
    }

    // Insert at top
    latestDxLog.unshift(entry);

    // Rebuild full index
    dxIndex.clear();
    latestDxLog.forEach((e, i) => dxIndex.set(e.key, i));

    // Enforce max size
    if (latestDxLog.length > MAX_LOG_ENTRIES) {
        const removed = latestDxLog.pop();
        dxIndex.delete(removed.key);
    }
}

function makeDxKey(freq, pi, itu, station) {
    return [freq || '', pi || '', itu || '', station || ''].join('|');
}

async function handleTextSocketMessage(event) {
    try {
        const eventData = JSON.parse(event.data);

        const {
            freq: frequency,
            pi: picode,
            txInfo
        } = eventData;

        if (!txInfo) return;

        const {
            tx: station,
            erp,
            city,
            itu,
            dist: distance,
            lat,
            lon
        } = txInfo;

        if (!distance || distance <= MINIMUM_DX_DISTANCE) return;

        const key = makeDxKey(frequency, picode, itu, station);
        const now = Date.now();
        const lastSeen = dxSeen.get(key) || 0;

        // Update memory if hold time passed
        if (now - lastSeen >= (DX_HOLD_TIME * 60 * 1000)) {
            dxSeen.set(key, now);
        }

        // --- Console logging ---
        const lastConsole = dxConsoleSeen.get(key) || 0;
        if (now - lastConsole >= (DX_CONSOLE_HOLD_TIME * 60 * 1000)) {
            const formatFrequency = (frequency) => {
                const numFrequency = Number(frequency);
                if (isNaN(numFrequency)) return frequency;

                return numFrequency % 1 === 0 ? numFrequency.toFixed(1) : numFrequency.toFixed(2).replace(/0$/, ''); 
            };

            dxConsoleSeen.set(key, now);
            logInfo(`[${pluginName}] ${station || "?"}, ${formatFrequency(frequency)} MHz (${erp || "?"}kW), ${city || ""} [${itu || ""}], ${distance} km`);

            if (SEND_EMAIL && nodemailer) {
                const emailConfig = { service: EMAIL_SERVICE, auth: { user: EMAIL_USER, pass: EMAIL_PASS } };

                const sendEmail = (subject, text) => {
                  nodemailer.createTransport(emailConfig).sendMail({
                    from: EMAIL_USER,
                    to: EMAIL_USER,
                    subject,
                    text
                  });
                };

                const subject = `[DX Log] ${ServerName.slice(0, 15)}... received ${station} [${itu}] on ${formatFrequency(frequency)} from ${distance} km`;
                const message = `[${ServerName}] Received ${station} on ${formatFrequency(frequency)} MHz (${erp || "?"}kW) with PI: ${picode} from ${city} in ${itu} which is ${distance} km.`;

                sendEmail(subject, message);
                logInfo(`[${pluginName}] DX email sent for ${station} on ${formatFrequency(frequency)} MHz`);
            }
        }

        // Clean old keys
        for (const [k, t] of dxSeen) {
            if (now - t > (DX_HOLD_TIME * 60 * 1000) * 4) dxSeen.delete(k);
        }
        for (const [k, t] of dxConsoleSeen) {
            if (now - t > (DX_CONSOLE_HOLD_TIME * 60 * 1000) * 4) dxConsoleSeen.delete(k);
        }

        // Upsert entry in latestDxLog
        const entry = {
            key,
            time: now,
            freq: frequency,
            pi: picode || null,
            station: station || null,
            city: city || null,
            itu: itu || null,
            distance,
            lat: lat || null,
            lon: lon || null
        };

        upsertDxLog(key, entry);

    } catch (error) {
        logError(`[${pluginName}] Error handling TextSocket message:`, error);
    }
}

async function setupTextSocket() {
    if (!TextSocket || TextSocket.readyState === WebSocket.CLOSED) {
        try {
            TextSocket = new WebSocket(externalWsUrl + '/text');

            TextSocket.addEventListener("open", () => {
                logInfo(`[${pluginName}] Text Websocket connected.`);
            });

            TextSocket.addEventListener("message", handleTextSocketMessage);

            TextSocket.addEventListener("error", (error) => {
                logError(`[${pluginName}] TextSocket error:`, error);
            });

            TextSocket.addEventListener("close", (event) => {
                logInfo(`[${pluginName}] TextSocket closed:`, event);
                setTimeout(setupTextSocket, 5000);
            });

            isFirstRun = false;

        } catch (error) {
            logError(`[${pluginName}] Failed to setup TextSocket:`, error);
            setTimeout(setupTextSocket, 5000);
        }
    }
}

// Init
checkConfigFile();
loadSettings();
customRouter();
setTimeout(setupTextSocket, 1000);
