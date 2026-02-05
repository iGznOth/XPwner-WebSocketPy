// src/handlers/monitor.js — CPU/RAM updates y logs
const db = require('../db');
const { broadcastToPanels } = require('../state');

/**
 * Worker envía métricas de CPU/RAM
 */
async function handleUpdate(socket, data) {
    const usage = data.usage;

    console.log(`[Monitor] Update de ID ${socket.userId}: CPU ${usage.cpu}%, RAM ${usage.ramUsedGB}GB/${usage.ramTotalGB}GB`);
    if (usage && typeof usage.cpu === 'number' && typeof usage.ramUsedGB === 'string') {
        await db.query(`
            INSERT INTO monitors (cuenta_id, cpu_usage, ram_usage, last_update)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                cpu_usage = VALUES(cpu_usage),
                ram_usage = VALUES(ram_usage),
                last_update = NOW()
        `, [socket.userId, usage.cpu, usage.ramUsedGB]);

        // Reenviar a los paneles de esa cuenta
        broadcastToPanels(socket.userId, {
            type: 'usage',
            cpu: usage.cpu,
            ramUsedGB: usage.ramUsedGB,
            ramTotalGB: usage.ramTotalGB || '16'
        });
    }
}

/**
 * Worker envía un log
 */
async function handleLog(socket, data) {
    const tipo_log = data.log_type || 'info';
    const mensaje = data.message || '';

    await db.query('INSERT INTO log (cuenta_id, tipo_log, mensaje) VALUES (?, ?, ?)', [socket.userId, tipo_log, mensaje]);
    console.log(`[Monitor] Log de ID ${socket.userId}: ${tipo_log} - ${mensaje}`);
}

module.exports = { handleUpdate, handleLog };
