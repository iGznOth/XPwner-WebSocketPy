// src/state.js — Estado global: conexiones de monitors y panels
const WebSocket = require('ws');

const monitors = new Map(); // cuenta_id => Set<socket>
const panels = new Map();   // cuenta_id => Set<socket>

/**
 * Registra un monitor (worker) en el Map
 */
function addMonitor(userId, socket) {
    if (!monitors.has(userId)) {
        monitors.set(userId, new Set());
    }
    monitors.get(userId).add(socket);
}

/**
 * Elimina un monitor del Map
 */
function removeMonitor(userId, socket) {
    const userMonitors = monitors.get(userId);
    if (userMonitors) {
        userMonitors.delete(socket);
        if (userMonitors.size === 0) {
            monitors.delete(userId);
            return true; // último monitor eliminado
        }
    }
    return false;
}

/**
 * Registra un panel en el Map
 */
function addPanel(userId, socket) {
    if (!panels.has(userId)) {
        panels.set(userId, new Set());
    }
    panels.get(userId).add(socket);
}

/**
 * Elimina un panel del Map
 */
function removePanel(userId, socket) {
    const userPanels = panels.get(userId);
    if (userPanels) {
        userPanels.delete(socket);
        if (userPanels.size === 0) {
            panels.delete(userId);
        }
    }
}

/**
 * Obtiene todos los monitors de una cuenta
 */
function getMonitors(userId) {
    return monitors.get(userId) || new Set();
}

/**
 * Obtiene todos los panels de una cuenta
 */
function getPanels(userId) {
    return panels.get(userId) || new Set();
}

/**
 * Envía un mensaje a todos los panels de una cuenta
 */
function broadcastToPanels(userId, data) {
    const userPanels = panels.get(userId);
    console.log(`[Broadcast] userId=${userId}, panels=${userPanels ? userPanels.size : 0}, type=${data.type}`);
    if (userPanels) {
        const msg = JSON.stringify(data);
        for (const panelSocket of userPanels) {
            if (panelSocket.readyState === WebSocket.OPEN) {
                panelSocket.send(msg);
            }
        }
    }
}

/**
 * Envía un mensaje a todos los monitors de una cuenta
 */
function broadcastToMonitors(userId, data) {
    const userMonitors = monitors.get(userId);
    if (userMonitors) {
        const msg = JSON.stringify(data);
        for (const monitorSocket of userMonitors) {
            if (monitorSocket.readyState === WebSocket.OPEN) {
                monitorSocket.send(msg);
            }
        }
    }
}

module.exports = {
    monitors,
    panels,
    addMonitor,
    removeMonitor,
    addPanel,
    removePanel,
    getMonitors,
    getPanels,
    broadcastToPanels,
    broadcastToMonitors
};
