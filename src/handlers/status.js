// src/handlers/status.js — Manejo de status, progreso y token health
// xWarmer health updates ahora se manejan en warmer.js
const db = require('../db');
const { sendCompletionNotification } = require('./telegram');

/**
 * Worker reporta status de una acción (Completado / Error)
 */
async function handleStatus(socket, data) {
    const { action_id, status, message: errorMsg, tipo } = data;

    if (action_id && status && errorMsg) {
        const [actionRows] = await db.query(
            `SELECT worker_id, comentario as prev_comment FROM actions WHERE id = ?`,
            [action_id]
        );
        if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
            let commentToSave = errorMsg;
            if (status === 'En Cola' && actionRows[0].prev_comment && actionRows[0].prev_comment.includes('https://')) {
                commentToSave = actionRows[0].prev_comment;
            }

            if (status === 'Completado' || status === 'Error') {
                await db.query(`UPDATE actions SET estado = ?, comentario = ? WHERE id = ?`, [status, commentToSave, action_id]);
            } else if (status === 'En Cola') {
                await db.query(`UPDATE actions SET estado = 'En Cola', worker_id = NULL, comentario = ? WHERE id = ?`, [commentToSave, action_id]);
                console.log(`[Status] Acción ${action_id} devuelta a 'En Cola' por worker ${socket.workerId}`);
            } else {
                await db.query(`UPDATE actions SET estado = CASE WHEN estado NOT IN ('Completado', 'Error') THEN ? ELSE estado END, comentario = ? WHERE id = ?`, [status, commentToSave, action_id]);
            }

            // Clean up media data when action is completed or errored
            if (status === 'Completado' || status === 'Error') {
                await db.query(`UPDATE actions SET media = NULL WHERE id = ? AND media IS NOT NULL`, [action_id]);
            }

            console.log(`[Status] Acción ${action_id} actualizada: ${status}`);

            // Notificación Telegram solo al completar
            if (status === 'Completado') {
                sendCompletionNotification(action_id);
            }
        } else {
            console.warn(`[Status] Worker ${socket.workerId} intentó actualizar acción ${action_id} no asignada.`);
        }
    }

    if (status && status.toLowerCase() === 'error') {
        await db.query('UPDATE cuentas SET estado_monitor = ? WHERE id = ?', ['Error', socket.userId]);
    }
}

/**
 * Worker reporta progreso de una acción
 */
async function handleProgress(socket, data) {
    const { action_id, cantidad } = data;

    const [actionRows] = await db.query('SELECT worker_id FROM actions WHERE id = ?', [action_id]);
    if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
        await db.query(
            'UPDATE actions SET estado = CASE WHEN estado NOT IN (\'Completado\', \'Error\') THEN \'En Proceso\' ELSE estado END, acciones_realizadas = acciones_realizadas + ? WHERE id = ?',
            [cantidad, action_id]
        );
        console.log(`[Status] Progreso: Acción ${action_id} +${cantidad} por worker ${socket.workerId}`);
    }
}

/**
 * Worker reporta fallo de un token específico
 */
async function handleTokenFail(socket, data) {
    const { auth_token, error_msg } = data;
    if (!auth_token || !socket.userId) return;

    try {
        await db.query(`
            INSERT INTO token_health (cuentas_id, auth_token, fails_consecutivos, ultimo_error, ultimo_uso, estado)
            VALUES (?, ?, 1, ?, NOW(), 'activo')
            ON DUPLICATE KEY UPDATE
                fails_consecutivos = fails_consecutivos + 1,
                ultimo_error = VALUES(ultimo_error),
                ultimo_uso = NOW(),
                estado = CASE 
                    WHEN fails_consecutivos + 1 >= 10 THEN 'muerto'
                    WHEN fails_consecutivos + 1 >= 5 THEN 'enfermo'
                    ELSE 'activo'
                END
        `, [socket.userId, auth_token, error_msg || 'unknown']);
    } catch (err) {
        console.error(`[TokenHealth] Error guardando token fail:`, err.message);
    }
}

/**
 * Worker reporta éxito de un token
 */
async function handleTokenSuccess(socket, data) {
    const { auth_token } = data;
    if (!auth_token || !socket.userId) return;

    try {
        await db.query(`
            UPDATE token_health 
            SET fails_consecutivos = 0, estado = 'activo', ultimo_uso = NOW()
            WHERE cuentas_id = ? AND auth_token = ?
        `, [socket.userId, auth_token]);
    } catch (err) { /* Silencioso */ }
}

/**
 * Worker envía snapshot del tweet al completar
 */
async function handleTweetSnapshot(socket, data) {
    const { action_id, data: tweetData } = data;
    if (!action_id || !tweetData) return;

    try {
        const [actionRows] = await db.query('SELECT worker_id FROM actions WHERE id = ?', [action_id]);
        if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
            await db.query('UPDATE actions SET tweet_snapshot = ? WHERE id = ?', [JSON.stringify(tweetData), action_id]);
            console.log(`[Snapshot] Tweet snapshot guardado para acción ${action_id}`);
        }
    } catch (err) {
        console.error(`[Snapshot] Error guardando snapshot para acción ${action_id}:`, err.message);
    }
}

module.exports = {
    handleStatus,
    handleProgress,
    handleTokenFail,
    handleTokenSuccess,
    handleTweetSnapshot
};
