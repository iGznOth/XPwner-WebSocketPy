// src/handlers/disconnect.js — Limpieza al desconectar
const WebSocket = require('ws');
const db = require('../db');
const { removeMonitor, removePanel, broadcastToPanels } = require('../state');

/**
 * Maneja desconexión de un socket
 */
async function handleDisconnect(socket) {
    console.log('[Server] Cliente desconectado.');

    if (socket.clientType === 'monitor' && socket.userId) {
        const wasLast = removeMonitor(socket.userId, socket);

        if (wasLast) {
            await db.query('UPDATE cuentas SET estado_monitor = ? WHERE id = ?', ['Desconectado', socket.userId]);
        }

        await db.query('INSERT INTO log (cuenta_id, tipo_log, mensaje) VALUES (?, ?, ?)',
            [socket.userId, 'error', `Monitor desconectado (workerId: ${socket.workerId}).`]);

        // Solo afecta acciones de este worker específico
        await db.query(
            'UPDATE actions SET estado = "En Cola", worker_id = NULL WHERE cuentas_id = ? AND worker_id = ? AND estado IN ("Pendiente de Aceptacion", "En Proceso")',
            [socket.userId, socket.workerId]
        );
        await db.query(
            'UPDATE xwarmer_actions SET estado = "En Cola", worker_id = NULL WHERE worker_id = ? AND estado IN ("En Proceso")',
            [socket.workerId]
        );

        // Notificar a paneles
        broadcastToPanels(socket.userId, { type: 'disconnect' });

    } else if (socket.clientType === 'panel' && socket.userId) {
        removePanel(socket.userId, socket);
        console.log('[Server] Panel desconectado.');
    }
}

module.exports = { handleDisconnect };
