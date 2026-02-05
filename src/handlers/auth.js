// src/handlers/auth.js — Autenticación de monitors y panels
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { addMonitor, addPanel } = require('../state');

async function handleAuth(socket, data) {
    const [rows] = await db.query('SELECT id FROM cuentas WHERE token = ? AND tipo=?', [data.token, "SuperAdministrador"]);

    if (rows.length > 0) {
        socket.clientType = data.client_type || "monitor";
        socket.userId = rows[0].id;
        socket.isAlive = true;

        if (socket.clientType === 'monitor') {
            socket.workerId = uuidv4();
            addMonitor(socket.userId, socket);

            await db.query('UPDATE cuentas SET estado_monitor = ? WHERE id = ?', ['Conectado', socket.userId]);

            if (!data.reconnect) {
                await db.query("UPDATE actions SET estado = ? WHERE estado= ? AND cuentas_id = ?", ["En Cola", "Desconeccion", socket.userId]);
                // Devolver warmer jobs en proceso de este worker a cola
                await db.query("UPDATE xwarmer_actions SET estado = 'En Cola', worker_id = NULL WHERE estado = 'En Proceso' AND worker_id = ?", [socket.workerId]);
            }

        } else if (socket.clientType === 'panel') {
            addPanel(socket.userId, socket);
        }

        socket.send(JSON.stringify({ type: 'auth', success: true }));
        console.log(`[Auth] Usuario autenticado. ID: ${socket.userId} como ${socket.clientType} con workerId: ${socket.workerId}`);
    } else {
        socket.send(JSON.stringify({ type: 'auth', success: false, error: 'Token inválido' }));
        console.warn('[Auth] Token inválido. Cerrando conexión.');
        socket.close();
    }
}

module.exports = { handleAuth };
