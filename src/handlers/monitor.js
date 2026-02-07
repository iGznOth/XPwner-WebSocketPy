// src/handlers/monitor.js — CPU/RAM updates y logs
const { broadcastToPanels } = require('../state');

/**
 * Worker envía métricas de CPU/RAM
 * Ya no guarda en DB (tabla monitors eliminada), solo reenvía a paneles
 */
async function handleUpdate(socket, data) {
    const usage = data.usage;

    if (usage && typeof usage.cpu === 'number') {
        // Reenviar a los paneles de esa cuenta
        broadcastToPanels(socket.userId, {
            type: 'usage',
            cpu: usage.cpu,
            ramUsedGB: usage.ramUsedGB || '0',
            ramTotalGB: usage.ramTotalGB || '16'
        });
    }
}

/**
 * Worker envía un log
 * Ya no guarda en DB (tabla log eliminada), solo broadcast
 */
async function handleLog(socket, data) {
    const tipo_log = data.log_type || 'info';
    const mensaje = data.message || '';

    // Broadcast a paneles si se necesita
    broadcastToPanels(socket.userId, {
        type: 'worker_log',
        log_type: tipo_log,
        message: mensaje
    });
}

module.exports = { handleUpdate, handleLog };
