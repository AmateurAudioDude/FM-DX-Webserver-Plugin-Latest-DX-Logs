/*
    Latest DX Logs v1.0.1 by AAD
    https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Latest-DX-Logs
*/

'use strict';

(() => {

//////////////////////////////////////////////////////////////////////////////////////////

const ENABLE_PLUGIN = true;                 // enable or disable plugin
const DX_DISPLAY_COUNT = 8;                 // maximum number of stations in rotation
const DX_SESSION_TIME = 1440;               // minutes before plugin fades out
const DX_CYCLE_TIME = 8;                    // seconds before cycling to the next entry
const DX_MAX_AGE_MIN = 12;                  // ignore entries older than x hours
const EVENT_LOCATION = 1;                   // fixed ticker location: 1, 2, 3, 4, or 5
const EVENT_LOCATION_OFFSET_MOBILE = 0;     // offset in px for mobile

//////////////////////////////////////////////////////////////////////////////////////////

// Check for update variables
const pluginVersion = '1.0.1';
const pluginName = "Latest DX Logs";
const pluginHomepageUrl = "https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Latest-DX-Logs";
const pluginUpdateUrl = "https://raw.githubusercontent.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Latest-DX-Logs/refs/heads/main/LatestDXLogs/pluginLatestDXLogs.js";
const pluginSetupOnlyNotify = true;
const CHECK_FOR_UPDATES = true;

document.addEventListener("DOMContentLoaded", function () {

if (ENABLE_PLUGIN && window.location.pathname !== '/setup') {

// Fetch endpoint
async function fetchDxLog() {
    const res = await fetch("/latest-dx-log-plugin", {
        headers: { "X-Plugin-Name": "LatestDxLogPlugin" },
        cache: "no-store"
    });

    if (!res.ok) return null;
    return res.json();
}

function buildDxDisplayList(data) {
    if (!data || !data.entries?.length) return [];

    const now = Date.now();
    const maxAgeMs = (DX_MAX_AGE_MIN * 60) * 60000;

    const filtered = data.entries.filter(e => {
        return (now - e.time) <= maxAgeMs;
    });

    return filtered.slice(0, DX_DISPLAY_COUNT);
}

// let variables
let dxIndex = 0;
let dxSessionStart = 0;
let dxTimer = null;
let dxEntries = [];
let lastDxList = [];

function startDxSession(entries) {
    if (!entries.length) return;

    dxEntries = entries;
    dxIndex = 0;

    if (dxTimer) clearInterval(dxTimer);

    if (entries.length === 1) {
        showDxEntry(entries[0], false, true);
        setTimeout(fadeDxOut, DX_SESSION_TIME * 60 * 1000);
        return;
    }

    // Show first entry immediately
    showDxEntry(dxEntries[0], true, true);

    // Start cycling interval
    dxTimer = setInterval(cycleDxEntry, DX_CYCLE_TIME * 1000);
}

function cycleDxEntry() {
    if (!dxEntries || dxEntries.length === 0) return;

    dxIndex = (dxIndex + 1) % dxEntries.length;
    const highlight = dxIndex === 0;
    showDxEntry(dxEntries[dxIndex], true, highlight);
}

function showDxEntry(entry, useFade = true, highlight = false) {
    const FADE_MS = 800;
    const freqEl = document.getElementById("data-frequency");
    if (!freqEl) return;

    const agoMin = Math.max(0, Math.floor((Date.now() - entry.time) / 60000));
    const freqNum = Number(entry.freq);
    const distNum = Number(entry.distance);

    const hours = Math.floor(agoMin / 60);
    const minutes = agoMin % 60;

    let timeText;
    let timeSuffix = " ago";
    if (agoMin === 0) {
        timeText = "just now";
        timeSuffix = "";
    } else if (hours > 0) {
        timeText = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    } else {
        timeText = `${minutes}m`;
    }

    const fullStation = entry.station || "?";
    const displayStation = fullStation.slice(0, 15);
    const freq    = isNaN(freqNum) ? "?" : freqNum.toFixed(1);
    const dist    = localStorage.getItem('imperialUnits') !== 'true' ? isNaN(distNum) ? "?" : distNum + " km" : isNaN(distNum) ? "?" : parseInt(distNum / 1.60934) + " mi";
    const time    = timeText + timeSuffix;

    // FontAwesome icons
    const ICON_STATION  = '<i class="fa-solid fa-broadcast-tower dx-sep"></i>';
    const ICON_FREQ     = '<i class="fa-solid fa-wave-square dx-sep"></i>';
    const ICON_DISTANCE = '<i class="fa-solid fa-location-dot dx-sep"></i>';
    const ICON_TIME     = '<i class="fa-solid fa-clock dx-sep"></i>';

    // Station fade effect using mask-image
    const stationHtml = fullStation.length > 15
        ? `<span style="
            max-width: 15ch;
            white-space: nowrap;
            overflow: hidden;
            -webkit-mask-image: linear-gradient(to right, black 80%, transparent 100%);
            -webkit-mask-repeat: no-repeat;
            -webkit-mask-size: 100% 100%;
            mask-image: linear-gradient(to right, black 80%, transparent 100%);
            mask-repeat: no-repeat;
            mask-size: 100% 100%;
        ">${displayStation}</span>`
        : displayStation;

    const html =
        `${ICON_STATION} ${stationHtml} ` +
        `${ICON_FREQ} ${freq} ` +
        `${ICON_DISTANCE} ${dist} ` +
        `${ICON_TIME} ${time}`;

    let note = document.getElementById("last-log-note");
    if (!note) {
        note = document.createElement("div");
        note.id = "last-log-note";

        let bottomValue, mobileOffset = 18;

        if (EVENT_LOCATION === 1) {
            bottomValue = `calc(${innerWidth <= 768 ? `100% - ${EVENT_LOCATION_OFFSET_MOBILE + mobileOffset}px` : (innerHeight <= 720 && innerWidth >= 920) ? '50% + 6.5px' : '50% - 1px'})`;
        } else if (EVENT_LOCATION === 2) {
            bottomValue = `calc(${innerWidth <= 768 ? `100% - ${EVENT_LOCATION_OFFSET_MOBILE + mobileOffset}px` : (innerHeight <= 720 && innerWidth >= 920) ? '100%' : '100%'})`;
        } else if (EVENT_LOCATION === 3) {
            bottomValue = `calc(${innerWidth <= 768 ? `100% - ${EVENT_LOCATION_OFFSET_MOBILE + mobileOffset}px` : (innerHeight <= 720 && innerWidth >= 920) ? '100% - 18px' : '100% - 18px'})`;
        } else if (EVENT_LOCATION === 4) {
            bottomValue = `calc(${innerWidth <= 768 ? `100% - ${EVENT_LOCATION_OFFSET_MOBILE + mobileOffset}px` : (innerHeight <= 720 && innerWidth >= 920) ? '0%' : '0%'})`;
        } else if (EVENT_LOCATION === 5) {
            bottomValue = `calc(${innerWidth <= 768 ? `100% - ${EVENT_LOCATION_OFFSET_MOBILE + mobileOffset}px` : (innerHeight <= 720 && innerWidth >= 920) ? '0% - 18px' : '0% - 18px'})`;
        } else {
            bottomValue = `calc(${innerWidth <= 768 ? `100% - ${EVENT_LOCATION_OFFSET_MOBILE + mobileOffset}px` : (innerHeight <= 720 && innerWidth >= 920) ? '50% + 6.5px' : '50% - 1px'})`;
        }

        note.style.cssText = `
            position: absolute;
            left: 50%;
            bottom: ${bottomValue};
            transform: translateX(-50%);
            opacity: 0;
            transition: opacity 0.8s ease, filter 0.3s ease;
            pointer-events: auto;
            white-space: nowrap;
            padding: 0 10px;
            user-select: none;
            cursor: help;
            color: var(--color-text);
            font-size: 13px;
            font-weight: 600;
            font-family: 'Titillium Web', sans-serif;
        `;

        freqEl.parentElement.style.position ||= "relative";
        freqEl.parentElement.appendChild(note);

        // Click cycles to next entry
        note.addEventListener("click", (e) => {
            // Do nothing if there is only one DX entry
            if (!dxEntries || dxEntries.length <= 1) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Reset the cycle timer so DX_CYCLE_TIME restarts from zero
            clearInterval(dxTimer);
            cycleDxEntry();
            dxTimer = setInterval(cycleDxEntry, DX_CYCLE_TIME * 1000);
        });
    }

    function updateNoteFontSize(note, plainTextLength) {
        const smallerFont = innerWidth > 768 && innerWidth < 1180;
        note.style.fontSize = smallerFont ? "11px" : "13px";
        note.style.letterSpacing = (plainTextLength >= 50 || smallerFont) ? "-0.5px" : "-0.25px";
    }

    // Brightness highlight
    setTimeout(() => {
        note.style.filter = highlight && dxEntries.length > 1 ? "brightness(1.85)" : "brightness(0.75)";
    }, FADE_MS / 2);

    const plainLength = (displayStation + freq + dist + time).length;

    if (!useFade) {
        note.innerHTML = html;
        updateNoteFontSize(note, plainLength);
        note.style.opacity = "1";
        return;
    }

    note.style.opacity = "0";
    setTimeout(() => {
        note.innerHTML = html;
        updateNoteFontSize(note, plainLength);
        note.style.opacity = "1";
    }, FADE_MS);
}

if (!document.getElementById("dx-icon-style")) {
    const style = document.createElement("style");
    style.id = "dx-icon-style";
    style.textContent = `
        .dx-sep {
            font-size: 0.85em;
            opacity: 0.65;
            margin: 0 1px 0 2px;
            display: inline-flex;
            align-items: center;
            line-height: 1;
            transform: translateY(-0.5px);
        }
    `;
    document.head.appendChild(style);
}

function fadeDxOut() {
    const note = document.getElementById("last-log-note");
    if (note) note.style.opacity = "0";
}

async function pollDx() {
    const data = await fetchDxLog();
    if (!data) return;

    const list = buildDxDisplayList(data);

    // Always store last server state
    lastDxList = list;

    if (!list.length) {
        mergeDxEntries(lastDxList);
        return;
    }

    if (dxEntries.length === 0) {
        startDxSession(list);
        return;
    }

    // Merge without resetting playback
    mergeDxEntries(list);
}

function mergeDxEntries(newList) {
    const now = Date.now();
    const maxAgeMs = (DX_MAX_AGE_MIN * 60) * 60000;

    const oldByKey = new Map(dxEntries.map(e => [e.key, e]));
    const merged = [];

    const wasSingle = dxEntries.length <= 1;

    const seenKeys = new Set();

    // Only keep non-expired entries
    for (const e of newList) {
        if ((now - e.time) > maxAgeMs) continue;

        const old = oldByKey.get(e.key);

        if (old) {
            if (e.time > old.time) old.time = e.time;
            merged.push(old);
        } else {
            merged.push(e); // new DX
        }

        seenKeys.add(e.key);
    }

    // Keep existing entries
    for (const e of dxEntries) {
        if (seenKeys.has(e.key)) continue;
        if ((now - e.time) > maxAgeMs) continue;

        merged.push(e);
    }

    dxEntries = merged.slice(0, DX_DISPLAY_COUNT);
    const isSingle = dxEntries.length <= 1;

    /* ---- STATE TRANSITIONS ---- */

    // Fade out if no remaining DX
    if (dxEntries.length === 0) {
        clearInterval(dxTimer);
        dxTimer = null;
        fadeDxOut();
        return;
    }

    // Multiple to single
    if (!wasSingle && isSingle) {
        clearInterval(dxTimer);
        dxTimer = null;
        dxIndex = 0;
        showDxEntry(dxEntries[0], false, true);
        return;
    }

    // Single to multiple
    if (wasSingle && !isSingle) {
        dxIndex = 0;
        showDxEntry(dxEntries[0], true, true);
        dxTimer = setInterval(cycleDxEntry, DX_CYCLE_TIME * 1000);
        return;
    }

    // Update content without fading
    if (isSingle) {
        showDxEntry(dxEntries[0], false, true);
    }
}

function pollDxLoop() {
    const elapsed = (Date.now() - dxSessionStart) / 1000;
    if (parseInt(elapsed) >= DX_SESSION_TIME * 60) {
        clearInterval(dxTimer);
        fadeDxOut();
        return;
    }

    pollDx(); // normal polling

    setTimeout(pollDxLoop, 60000);
}

// Start session
dxSessionStart = Date.now();
pollDxLoop();

} // End of ENABLE_PLUGIN if

if (window.location.pathname === '/setup') {
    // Function for update notification in /setup
    function checkUpdate(e,n,t,o){if(e&&"/setup"!==location.pathname)return;let i="undefined"!=typeof pluginVersion?pluginVersion:"undefined"!=typeof plugin_version?plugin_version:"undefined"!=typeof PLUGIN_VERSION?PLUGIN_VERSION:"Unknown";async function r(){try{let e=await fetch(o);if(!e.ok)throw new Error("["+n+"] update check HTTP error! status: "+e.status);let t=(await e.text()).split("\n"),r;if(t.length>2){let e=t.find(e=>e.includes("const pluginVersion =")||e.includes("const plugin_version =")||e.includes("const PLUGIN_VERSION ="));if(e){let n=e.match(/const\s+(?:pluginVersion|plugin_version|PLUGIN_VERSION)\s*=\s*['"]([^'"]+)['"]/);n&&(r=n[1])}}return r||(r=/^\d/.test(t[0].trim())?t[0].trim():"Unknown"),r}catch(e){return console.error("["+n+"] error fetching file:",e),null}}r().then(e=>{e&&e!==i&&(console.log("["+n+"] There is a new version of this plugin available"),function(e,n,t,o){if("/setup"===location.pathname){let i=document.getElementById("plugin-settings");if(i){let r=i.textContent.trim(),l=`<a href="${o}" target="_blank">[${t}] Update available: ${e} --> ${n}</a><br>`;i.innerHTML="No plugin settings are available."===r?l:i.innerHTML+" "+l}let a=document.querySelector(".wrapper-outer #navigation .sidenav-content .fa-puzzle-piece")||document.querySelector(".wrapper-outer .sidenav-content")||document.querySelector(".sidenav-content"),d=document.createElement("span");d.style.cssText="display:block;width:12px;height:12px;border-radius:50%;background:#FE0830;margin-left:82px;margin-top:-12px",a.appendChild(d)}}(i,e,n,t))})}CHECK_FOR_UPDATES&&checkUpdate(pluginSetupOnlyNotify,pluginName,pluginHomepageUrl,pluginUpdateUrl);
}

}); // End of DOMContentLoaded

})();
