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

            // Resetear acciones huérfanas (de workers anteriores que murieron)
            // En conexión nueva: resetear "Desconeccion" + cualquier "En Proceso"/"Pendiente de Aceptacion" de esta cuenta
            const [stale] = await db.query(
                `UPDATE actions SET estado = 'En Cola', worker_id = NULL 
                 WHERE cuentas_id = ? AND estado IN ('Desconeccion', 'En Proceso', 'Pendiente de Aceptacion')`,
                [socket.userId]
            );
            if (stale.affectedRows > 0) {
                console.log(`[Auth] Reset ${stale.affectedRows} acciones huérfanas para cuenta ${socket.userId}`);
            }
            // Devolver warmer/scraping jobs huérfanos
            await db.query("UPDATE xwarmer_actions SET estado = 'En Cola', worker_id = NULL WHERE estado = 'En Proceso'");
            await db.query(`UPDATE scraping_jobs SET estado = 'En Cola', worker_id = NULL, procesados = 0, exitosos = 0, errores = 0 WHERE estado = 'En Proceso'`);

        } else if (socket.clientType === 'panel') {
            addPanel(socket.userId, socket);
        }

        socket.send(JSON.stringify({ type: 'auth', success: true }));
        // console.log(`[Auth] Usuario autenticado. ID: ${socket.userId} como ${socket.clientType} con workerId: ${socket.workerId}`);
    } else {
        socket.send(JSON.stringify({ type: 'auth', success: false, error: 'Token inválido' }));
        console.warn('[Auth] Token inválido. Cerrando conexión.');
        socket.close();
    }
}

module.exports = { handleAuth };
