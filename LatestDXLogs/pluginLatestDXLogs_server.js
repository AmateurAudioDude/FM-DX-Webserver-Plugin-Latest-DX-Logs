/*
    Latest DX Logs v1.1.0 by AAD
    https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Latest-DX-Logs

    //// Server-side code ////
*/

'use strict';

const pluginName = "DX Log";

const LOG_ENTRY_MAX_AGE_HOURS = 48;             // server-side pruning: drop log entries older than this

const dxSeen = new Map();                       // key --> lastSeen timestamp
const dxConsoleSeen = new Map();                // last logged to console
const dxIndex = new Map();                      // key --> array index
const latestDxLog = [];
const emailTruncatedTitle = 20;                 // characters

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
const logHistoryFilePath = path.join(__dirname, 'dxLogHistory.json');

// const variables
const debug = false;
const webserverPort = config.webserver.webserverPort || 8080;
const externalWsUrl = `ws://127.0.0.1:${webserverPort}`;

// let variables
let isFirstRun = true;
let isDxLogUpdated = false;
let ipAddress = externalWsUrl;
let TextSocket;
let ipTimeout;
let nodemailer;
let MINIMUM_DX_DISTANCE, MAX_LOG_ENTRIES, DX_HOLD_TIME, DX_CONSOLE_HOLD_TIME, SEND_EMAIL, EMAIL_SERVICE, EMAIL_USER, EMAIL_PASS;
let CENTRAL_SERVER_URL, CENTRAL_SERVER_TOKEN, SEND_RECEIVER_NAME, ENABLE_CENTRAL_INGEST, INGEST_LOCAL_ONLY;

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
            "emailPass": "",
            "centralServerUrl": "",
            "centralServerToken": "",
            "sendReceiverName": true,
            "enableCentralIngest": false,
            "ingestLocalOnly": true
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
    emailPass: '',
    centralServerUrl: '',
    centralServerToken: '',
    sendReceiverName: true,
    enableCentralIngest: false,
    ingestLocalOnly: true
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
        CENTRAL_SERVER_URL = configData.centralServerUrl ?? '';                 // forward entries to this server
        CENTRAL_SERVER_TOKEN = configData.centralServerToken ?? '';             // shared secret for central server
        SEND_RECEIVER_NAME = configData.sendReceiverName ?? true;               // include this server's name in forwarded entries
        ENABLE_CENTRAL_INGEST = configData.enableCentralIngest ?? false;        // accept incoming entries from satellites
        INGEST_LOCAL_ONLY = configData.ingestLocalOnly ?? true;                 // restrict ingest to local network IPs

        logInfo(`[${pluginName}] Minimum distance: ${MINIMUM_DX_DISTANCE} km | Max log entries: ${MAX_LOG_ENTRIES} events | Hold time: ${DX_HOLD_TIME} min | Console hold time: ${DX_CONSOLE_HOLD_TIME} min | Send email: ${SEND_EMAIL} | Central: ${CENTRAL_SERVER_URL || 'none'} | Ingest: ${ENABLE_CENTRAL_INGEST}`);

        if (SEND_EMAIL) nodemailer = require('nodemailer');
    } catch (err) {
        logError(`[${pluginName}] Failed to parse ${configFileName}:`, err.message);
        if (SEND_EMAIL && !nodemailer) logError(`[${pluginName}] run "npm install nodemailer"`);
    }
}

function cleanUpExpiredLogs() {
    const now = Date.now();
    const maxAgeMs = LOG_ENTRY_MAX_AGE_HOURS * 60 * 60 * 1000;
    const holdMs = (DX_HOLD_TIME * 60 * 1000) * 4;
    const consoleHoldMs = (DX_CONSOLE_HOLD_TIME * 60 * 1000) * 4;
    let changed = false;

    // Prune latestDxLog by age
    for (let i = latestDxLog.length - 1; i >= 0; i--) {
        if (now - latestDxLog[i].time > maxAgeMs) {
            latestDxLog.splice(i, 1);
            changed = true;
        }
    }
    if (changed) {
        dxIndex.clear();
        latestDxLog.forEach((e, i) => dxIndex.set(e.key, i));
    }

    // Enforce count cap, upsertDxLog also handles this
    while (latestDxLog.length > MAX_LOG_ENTRIES) {
        const removed = latestDxLog.pop();
        dxIndex.delete(removed.key);
        changed = true;
    }

    // Prune seen-maps
    for (const [k, t] of dxSeen) {
        if (now - t > holdMs) { dxSeen.delete(k); changed = true; }
    }
    for (const [k, t] of dxConsoleSeen) {
        if (now - t > consoleHoldMs) { dxConsoleSeen.delete(k); changed = true; }
    }

    if (changed) {
        isDxLogUpdated = true;
        saveDxLog();
    }
}

function loadDxLog() {
    if (!fs.existsSync(logHistoryFilePath)) return;
    try {
        const data = JSON.parse(fs.readFileSync(logHistoryFilePath, 'utf8'));

        if (Array.isArray(data.latestDxLog)) {
            latestDxLog.push(...data.latestDxLog);
            dxIndex.clear();
            latestDxLog.forEach((e, i) => dxIndex.set(e.key, i));
        }

        if (data.dxSeen && typeof data.dxSeen === 'object') {
            for (const [k, t] of Object.entries(data.dxSeen)) dxSeen.set(k, t);
        }

        if (data.dxConsoleSeen && typeof data.dxConsoleSeen === 'object') {
            for (const [k, t] of Object.entries(data.dxConsoleSeen)) dxConsoleSeen.set(k, t);
        }

        const restored = latestDxLog.length;
        cleanUpExpiredLogs();
        logInfo(`[${pluginName}] Restored ${restored} log entr${restored === 1 ? 'y' : 'ies'} from ${path.basename(logHistoryFilePath)} (${latestDxLog.length} after pruning, max age ${LOG_ENTRY_MAX_AGE_HOURS}h)`);
    } catch (err) {
        logError(`[${pluginName}] Error loading DX log history:`, err.message);
    }
}

function saveDxLog() {
    if (!isDxLogUpdated) return;
    try {
        const data = {
            latestDxLog,
            dxSeen: Object.fromEntries(dxSeen),
            dxConsoleSeen: Object.fromEntries(dxConsoleSeen)
        };
        fs.writeFileSync(logHistoryFilePath, JSON.stringify(data, null, 4));
        isDxLogUpdated = false;
    } catch (err) {
        logError(`[${pluginName}] Error saving DX log history:`, err.message);
    }
}

// When centralServerUrl is set, forward every locally-committed entry to the
// central server's /latest-dx-log-ingest endpoint. The `receiver` field prevents
// re-forwarding entries that already arrived via ingest from another satellite.
async function forwardEntryToCentral(entry) {
    if (!CENTRAL_SERVER_URL || !entry) return;
    if (entry.receiver && String(entry.receiver).trim()) return;

    const payload = SEND_RECEIVER_NAME ? { ...entry, receiver: ServerName || '' } : entry;
    const target = CENTRAL_SERVER_URL.replace(/\/+$/, '') + '/latest-dx-log-ingest';
    try {
        const response = await fetch(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(CENTRAL_SERVER_TOKEN ? { Authorization: `Bearer ${CENTRAL_SERVER_TOKEN}` } : {})
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            logWarn(`[${pluginName}] Forward to central rejected (${response.status}): ${text.slice(0, 200)}`);
        }
    } catch (error) {
        logError(`[${pluginName}] Forward to central failed: ${error.message}`);
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

    // Accept a forwarded entry from a satellite server. Auth is the shared
    // centralServerToken sent as Bearer; the receiver must have enableCentralIngest set.
    endpointsRouter.post('/latest-dx-log-ingest', (req, res) => {
        if (!ENABLE_CENTRAL_INGEST) {
            res.status(403).json({ error: 'Central ingest disabled.' });
            return;
        }

        const expected = String(CENTRAL_SERVER_TOKEN || '').trim();
        if (!expected) {
            res.status(403).json({ error: 'Central ingest token not configured.' });
            return;
        }

        const auth = req.get('Authorization') || '';
        const match = auth.match(/^Bearer\s+(.+)$/i);
        const provided = match ? match[1].trim() : '';
        if (provided !== expected) {
            res.status(401).json({ error: 'Invalid token.' });
            return;
        }

        if (INGEST_LOCAL_ONLY) {
            const raw = req.ip || req.socket?.remoteAddress || '';
            const ip = raw.replace(/^::ffff:/, '');
            const isLocal = ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) ||
                /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
            if (!isLocal) {
                res.status(403).json({ error: 'Ingest restricted to local network.' });
                return;
            }
        }

        try {
            const body = req.body;
            if (!body || typeof body !== 'object') {
                res.status(400).json({ error: 'Invalid payload.' });
                return;
            }

            const key = body.key || makeDxKey(body.freq, body.pi, body.itu, body.station);
            if (!key || key === '|||') {
                res.status(400).json({ error: 'Missing or empty entry key.' });
                return;
            }

            const entry = {
                key,
                time:     typeof body.time === 'number' ? body.time : Date.now(),
                freq:     body.freq     ?? null,
                pi:       body.pi       ?? null,
                station:  body.station  ?? null,
                city:     body.city     ?? null,
                itu:      body.itu      ?? null,
                distance: body.distance ?? null,
                lat:      body.lat      ?? null,
                lon:      body.lon      ?? null,
                receiver: body.receiver ?? null
            };

            upsertDxLog(key, entry);
            saveDxLog();

            const freqFmt = Number.isFinite(Number(entry.freq)) ? Number(entry.freq).toFixed(1) : String(entry.freq || '?');
            logInfo(`[${pluginName}] Ingested ${entry.station || '?'} ${freqFmt} MHz from ${entry.receiver || 'satellite'}`);

            res.json({ ok: true });
        } catch (error) {
            logError(`[${pluginName}] Ingest failed: ${error.message}`);
            res.status(500).json({ error: error.message });
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

    isDxLogUpdated = true;
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
        const isNewEntry = (now - lastSeen >= (DX_HOLD_TIME * 60 * 1000));
        if (isNewEntry) {
            dxSeen.set(key, now);
            isDxLogUpdated = true;
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
            isDxLogUpdated = true;
            logInfo(`[${pluginName}] ${station || "?"}, ${formatFrequency(frequency)} MHz (${erp || "?"}kW), ${city || ""} [${itu || ""}], ${distance} km`);

            if (SEND_EMAIL && nodemailer) {
                const emailConfig = { service: EMAIL_SERVICE, auth: { user: EMAIL_USER, pass: EMAIL_PASS } };

                const sendEmail = (subject, text) => {
                  nodemailer.createTransport(emailConfig).sendMail({
                    from: EMAIL_USER,
                    to: EMAIL_USER,
                    subject,
                    text
                  }).catch(err => logError(`[${pluginName}] DX email failed: ${err.message}`));
                };

                const subject = `[DX Log] ${ServerName.slice(0, emailTruncatedTitle)}... received ${station} [${itu}] on ${formatFrequency(frequency)} from ${distance} km`;
                const message = `[${ServerName}] Received ${station} on ${formatFrequency(frequency)} MHz (${erp || "?"}kW) with PI: ${picode} from ${city} in ${itu} which is ${distance} km.`;

                sendEmail(subject, message);
                logInfo(`[${pluginName}] DX email sent for ${station} on ${formatFrequency(frequency)} MHz`);
            }
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
        if (isNewEntry) forwardEntryToCentral(entry);
        saveDxLog();

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
loadDxLog();
customRouter();
setTimeout(setupTextSocket, 1000);
setInterval(cleanUpExpiredLogs, 60 * 1000);
