// src/handlers/actions.js — Gestión de acciones normales (request, accept, reject, push)
// xWarmer jobs ahora se manejan en warmer.js
const db = require('../db');
const { getMonitors } = require('../state');

/**
 * Worker solicita una acción (pull model)
 */
async function handleRequestAction(socket, data) {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [actions] = await connection.query(
            `SELECT 
                a.id, 
                a.cuentas_id, 
                a.preconfig_id, 
                a.url, 
                a.tipo, 
                a.util, 
                a.cantidad, 
                a.comentario, 
                a.acciones_realizadas, 
                a.impulso, 
                a.request,
                a.modulo,
                a.media,
                COALESCE(p.proxy, NULL) AS proxy,
                COALESCE(p.proxy_request, NULL) AS proxy_request,
                COALESCE(p.tokens, NULL) AS tokens,
                COALESCE(p.chatid, NULL) AS chatid,
                COALESCE(p.apm, 60) AS apm
            FROM actions a 
            LEFT JOIN preconfigs p ON a.preconfig_id = p.id 
            WHERE a.estado = 'En Cola' 
              AND a.tipo = ? 
              AND a.cuentas_id = ? 
              AND a.fecha < NOW()
            ORDER BY a.id ASC 
            LIMIT 1 FOR UPDATE`,
            [data.tipo, socket.userId]
        );

        if (actions.length > 0) {
            const action = actions[0];
            await connection.query(
                `UPDATE actions SET estado = ?, worker_id = ? WHERE id = ?`,
                ['Pendiente de Aceptacion', socket.workerId, action.id]
            );

            await connection.commit();

            let dpayload = {
                type: 'action',
                action: {
                    id: action.id,
                    tipo: action.tipo,
                    url: action.url,
                    cantidad: action.cantidad,
                    proxy: action.proxy,
                    proxy_request: action.proxy_request || null,
                    tokens: action.tokens,
                    apm: action.apm || 60,
                    comentarios: action.comentario,
                    util: action.util,
                    chatid: action.chatid,
                    acciones_realizadas: action.acciones_realizadas,
                    request: action.request,
                    impulso: action.impulso,
                    modulo: action.modulo,
                    preconfig_id: action.preconfig_id,
                    use_token_manager: true,
                    media: action.media || null
                }
            };

            // Views: cargar tokens del deck
            if (action.tipo === 'view' && action.preconfig_id) {
                try {
                    const [deckTokens] = await db.query(
                        `SELECT id AS token_id, nick, auth_token, ct0, cookies_full
                         FROM xchecker_accounts 
                         WHERE deck_id = ? AND estado = 'active'
                         ORDER BY ultimo_uso ASC`,
                        [action.preconfig_id]
                    );
                    console.log(`[Actions] View acción ${action.id}: ${deckTokens.length} tokens para deck ${action.preconfig_id}`);
                    if (deckTokens.length > 0) {
                        dpayload.action.deck_tokens = deckTokens;
                        dpayload.action.use_token_manager = false;
                        dpayload.action.views_per_minute = parseInt(action.util) || 300;
                    }
                } catch (err) {
                    console.error(`[Actions] Error cargando tokens del deck para views: ${err.message}`);
                }
            }

            console.log(`[Actions] Acción ${action.id} enviada a worker ${socket.workerId} de cuenta ${socket.userId}`);
            socket.send(JSON.stringify(dpayload));
        } else {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'no_action' }));
        }
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

/**
 * Worker acepta la acción
 */
async function handleTaskAccepted(socket, data) {
    const { action_id } = data;

    const [actionRows] = await db.query('SELECT worker_id FROM actions WHERE id = ? AND estado = ?', [action_id, 'Pendiente de Aceptacion']);
    if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
        await db.query('UPDATE actions SET estado = ? WHERE id = ?', ['En Proceso', action_id]);
        console.log(`[Actions] Acción ${action_id} aceptada por worker ${socket.workerId}`);
    } else {
        console.warn(`[Actions] Worker ${socket.workerId} intentó aceptar acción ${action_id} no asignada.`);
    }
}

/**
 * Worker rechaza la acción
 */
async function handleTaskRejected(socket, data) {
    const { action_id } = data;

    const [actionRows] = await db.query('SELECT worker_id FROM actions WHERE id = ? AND estado = ?', [action_id, 'Pendiente de Aceptacion']);
    if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
        await db.query('UPDATE actions SET estado = ?, worker_id = NULL WHERE id = ?', ['En Cola', action_id]);
        console.log(`[Actions] Acción ${action_id} rechazada por worker ${socket.workerId}. Devuelta a 'En Cola'`);
    } else {
        console.warn(`[Actions] Worker ${socket.workerId} intentó rechazar acción ${action_id} no asignada.`);
    }
}

/**
 * Panel notifica nueva acción → broadcast a workers
 */
function handleNewAction(socket, data) {
    const { tipo } = data;
    if (!tipo || !socket.userId) return;

    const userMonitors = getMonitors(socket.userId);
    if (userMonitors.size === 0) {
        console.log(`[Actions] new_action ${tipo} para cuenta ${socket.userId} pero no hay workers conectados`);
        return;
    }

    const WebSocket = require('ws');
    const msg = JSON.stringify({ type: 'action_available', tipo: tipo });

    let notified = 0;
    for (const monitorSocket of userMonitors) {
        if (monitorSocket.readyState === WebSocket.OPEN) {
            monitorSocket.send(msg);
            notified++;
        }
    }

    console.log(`[Actions] new_action ${tipo} → notificados ${notified} workers de cuenta ${socket.userId}`);
}

module.exports = {
    handleRequestAction,
    handleTaskAccepted,
    handleTaskRejected,
    handleNewAction
};
