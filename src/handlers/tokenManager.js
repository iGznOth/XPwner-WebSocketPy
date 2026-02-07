// src/handlers/tokenManager.js — Gestión inteligente de tokens v2
// Asignación con locking, reporte de salud, actualización de cookies
const db = require('../db');
const errorRules = require('./errorRules');

/**
 * Worker solicita un token para ejecutar una acción
 * Selecciona el token activo, menos usado, que no haya hecho esa acción en ese tweet
 * Usa FOR UPDATE SKIP LOCKED para concurrencia
 */
async function handleRequestToken(socket, data) {
    const { deck_id, action_type, tweet_id, tweet_url } = data;

    if (!deck_id || !action_type) {
        socket.send(JSON.stringify({
            type: 'no_token_available',
            reason: 'missing_params',
            message: 'deck_id y action_type son requeridos'
        }));
        return;
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // Query de asignación inteligente:
        // 1. Token con estado activo en xchecker_accounts
        // 2. estado_salud NO sea deslogueado/suspendido/muerto
        // 3. Pertenece al deck solicitado (deck_id)
        // 4. No está bloqueado (locked = 0)
        // 5. NO ha hecho esta acción para este tweet (LEFT JOIN token_actions_log)
        // 6. Ordenado por ultimo_uso ASC (el menos usado primero, NULLs primero)
        // 7. FOR UPDATE SKIP LOCKED para evitar que 2 workers agarren el mismo
        const isView = action_type === 'view';
        let query = `
            SELECT xa.id, xa.nick, xa.auth_token, xa.ct0, xa.cookies_full
            FROM xchecker_accounts xa
            WHERE xa.deck_id = ?
              AND xa.estado = 'active'
              AND (xa.estado_salud NOT IN ('deslogueado', 'suspendido', 'muerto') OR xa.estado_salud IS NULL OR xa.estado_salud = 'desconocido')
              ${isView ? '' : 'AND xa.locked = 0'}
              AND xa.auth_token IS NOT NULL
              AND xa.ct0 IS NOT NULL
        `;
        const params = [deck_id];

        // Si hay tweet_id, excluir tokens que ya hicieron esta acción en este tweet
        // Views pueden repetir token — el mismo token puede dar múltiples views
        if (tweet_id && !isView) {
            query += `
              AND xa.id NOT IN (
                  SELECT token_id FROM token_actions_log 
                  WHERE tweet_id = ? AND action_type = ? AND resultado = 'success'
              )
            `;
            params.push(tweet_id, action_type);
        }

        query += `
            ORDER BY xa.ultimo_uso ASC
            LIMIT 1
            ${isView ? '' : 'FOR UPDATE SKIP LOCKED'}
        `;

        const [tokens] = await connection.query(query, params);

        if (tokens.length === 0) {
            // Diagnóstico: ¿por qué no hay tokens?
            let diagnostics = {};
            try {
                const [totalRows] = await connection.query(
                    `SELECT COUNT(*) as total FROM xchecker_accounts WHERE deck_id = ?`, [deck_id]
                );
                const [activeRows] = await connection.query(
                    `SELECT COUNT(*) as total FROM xchecker_accounts WHERE deck_id = ? AND estado = 'active'`, [deck_id]
                );
                const [withAuthRows] = await connection.query(
                    `SELECT COUNT(*) as total FROM xchecker_accounts WHERE deck_id = ? AND estado = 'active' AND auth_token IS NOT NULL AND ct0 IS NOT NULL`, [deck_id]
                );
                const [healthyRows] = await connection.query(
                    `SELECT COUNT(*) as total FROM xchecker_accounts WHERE deck_id = ? AND estado = 'active' AND auth_token IS NOT NULL AND ct0 IS NOT NULL AND (estado_salud NOT IN ('deslogueado', 'suspendido', 'muerto') OR estado_salud IS NULL OR estado_salud = 'desconocido')`, [deck_id]
                );
                const [unlockedRows] = await connection.query(
                    `SELECT COUNT(*) as total FROM xchecker_accounts WHERE deck_id = ? AND estado = 'active' AND auth_token IS NOT NULL AND ct0 IS NOT NULL AND (estado_salud NOT IN ('deslogueado', 'suspendido', 'muerto') OR estado_salud IS NULL OR estado_salud = 'desconocido') AND locked = 0`, [deck_id]
                );
                let usedCount = 0;
                if (tweet_id && action_type !== 'view') {
                    const [usedRows] = await connection.query(
                        `SELECT COUNT(*) as total FROM token_actions_log WHERE tweet_id = ? AND action_type = ? AND resultado = 'success'`, [tweet_id, action_type]
                    );
                    usedCount = usedRows[0].total;
                }
                diagnostics = {
                    total_in_deck: totalRows[0].total,
                    active: activeRows[0].total,
                    with_auth: withAuthRows[0].total,
                    healthy: healthyRows[0].total,
                    unlocked: unlockedRows[0].total,
                    already_used_this_tweet: usedCount
                };
                // console.log(`[TokenManager] No tokens para deck ${deck_id} (${action_type}): total=${diagnostics.total_in_deck} active=${diagnostics.active} auth=${diagnostics.with_auth} healthy=${diagnostics.healthy} unlocked=${diagnostics.unlocked} used=${diagnostics.already_used_this_tweet}`);
            } catch (diagErr) {
                console.error('[TokenManager] Error en diagnóstico:', diagErr.message);
            }

            await connection.commit();
            socket.send(JSON.stringify({
                type: 'no_token_available',
                reason: 'all_used_or_unhealthy',
                deck_id,
                action_type,
                diagnostics
            }));
            return;
        }

        const token = tokens[0];

        // Bloquear el token (views no necesita lock — el mismo token puede dar múltiples views)
        if (action_type !== 'view') {
            await connection.query(
                `UPDATE xchecker_accounts SET locked = 1, locked_by = ?, locked_at = NOW() WHERE id = ?`,
                [socket.workerId || 'unknown', token.id]
            );
        }

        await connection.commit();

        // console.log(`[TokenManager] Token ${token.id} (@${token.nick}) asignado a worker ${socket.workerId} para ${action_type}`);

        socket.send(JSON.stringify({
            type: 'token_assigned',
            token_id: token.id,
            nick: token.nick,
            auth_token: token.auth_token,
            ct0: token.ct0,
            cookies_full: token.cookies_full || null
        }));

    } catch (err) {
        await connection.rollback();
        console.error('[TokenManager] Error asignando token:', err.message);
        socket.send(JSON.stringify({
            type: 'no_token_available',
            reason: 'db_error',
            message: err.message
        }));
    } finally {
        connection.release();
    }
}

/**
 * Worker reporta resultado de usar un token
 * Actualiza: ultimo_uso, estado_salud, cookies, token_actions_log
 */
async function handleTokenReport(socket, data) {
    const { token_id, action_type, tweet_id, tweet_url, success, error_code, set_cookies } = data;

    if (!token_id) return;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Insertar en token_actions_log
        if (tweet_id && action_type) {
            await connection.query(
                `INSERT INTO token_actions_log (token_id, action_type, tweet_url, tweet_id, resultado, error_detail)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [token_id, action_type, tweet_url || '', tweet_id, success ? 'success' : 'fail', error_code || null]
            );
        }

        // 2. Actualizar xchecker_accounts
        const isView = action_type === 'view';
        if (success) {
            // Éxito: resetear fallos, estado activo
            await connection.query(
                `UPDATE xchecker_accounts SET 
                    ultimo_uso = NOW(), 
                    fails_consecutivos = 0, 
                    estado_salud = 'activo'
                    ${isView ? '' : ", locked = 0, locked_by = NULL, locked_at = NULL"}
                WHERE id = ?`,
                [token_id]
            );
        } else {
            // Fallo: extraer código numérico si viene en JSON
            let numericCode = null;
            const errStr = error_code || '';
            try {
                const parsed = JSON.parse(errStr);
                if (parsed.errors && parsed.errors[0] && parsed.errors[0].code) {
                    numericCode = parsed.errors[0].code;
                }
            } catch(e) {
                // No es JSON, intentar extraer número
                const m = errStr.match(/\b(\d{3})\b/);
                if (m) numericCode = parseInt(m[1]);
            }

            // Usar error rules dinámicas
            await errorRules.processError(connection, {
                account_id: token_id,
                action_id: null,
                module: action_type,
                error_code: numericCode,
                error_message: errStr
            }, false);

            // Unlock + update ultimo_uso
            await connection.query(
                `UPDATE xchecker_accounts SET ultimo_uso = NOW()
                    ${isView ? '' : ", locked = 0, locked_by = NULL, locked_at = NULL"}
                WHERE id = ?`,
                [token_id]
            );
        }

        // 3. Actualizar cookies si vienen en set_cookies
        if (set_cookies && typeof set_cookies === 'string' && set_cookies.trim().length > 0) {
            // Parsear set-cookie para extraer valores individuales
            const cookieUpdates = {};
            
            // set_cookies puede ser un string tipo "ct0=newvalue; auth_token=same; other=val"
            // o puede ser headers set-cookie raw separados por \n
            const parts = set_cookies.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
            for (const part of parts) {
                const eqIdx = part.indexOf('=');
                if (eqIdx === -1) continue;
                const key = part.substring(0, eqIdx).trim().toLowerCase();
                const val = part.substring(eqIdx + 1).trim();
                if (key === 'ct0' && val) cookieUpdates.ct0 = val;
                if (key === 'auth_token' && val) cookieUpdates.auth_token = val;
            }

            // Actualizar campos individuales si cambiaron
            const setClauses = ['cookies_full = ?'];
            const setParams = [set_cookies];

            if (cookieUpdates.ct0) {
                setClauses.push('ct0 = ?');
                setParams.push(cookieUpdates.ct0);
            }
            if (cookieUpdates.auth_token) {
                setClauses.push('auth_token = ?');
                setParams.push(cookieUpdates.auth_token);
            }

            setParams.push(token_id);
            await connection.query(
                `UPDATE xchecker_accounts SET ${setClauses.join(', ')} WHERE id = ?`,
                setParams
            );

            // console.log(`[TokenManager] Cookies actualizadas para token ${token_id}`);
        }

        await connection.commit();
        // console.log(`[TokenManager] Report: token ${token_id} → ${success ? 'success' : 'fail'} (${action_type})`);

    } catch (err) {
        await connection.rollback();
        console.error('[TokenManager] Error en token report:', err.message);
    } finally {
        connection.release();
    }
}

/**
 * Cleanup: desbloquear tokens que llevan más de 10 minutos bloqueados (timeout)
 * Se ejecuta periódicamente
 */
async function cleanupStaleLocks() {
    try {
        const [result] = await db.query(
            `UPDATE xchecker_accounts SET locked = 0, locked_by = NULL, locked_at = NULL 
             WHERE locked = 1 AND locked_at < NOW() - INTERVAL 10 MINUTE`
        );
        if (result.affectedRows > 0) {
            // console.log(`[TokenManager] Cleanup: ${result.affectedRows} tokens desbloqueados por timeout`);
        }
    } catch (err) {
        console.error('[TokenManager] Error en cleanup:', err.message);
    }
}

/**
 * Cleanup: eliminar logs de token_actions_log mayores a 60 días
 */
async function cleanupOldLogs() {
    try {
        const [result] = await db.query(
            `DELETE FROM token_actions_log WHERE created_at < NOW() - INTERVAL 60 DAY`
        );
        if (result.affectedRows > 0) {
            // console.log(`[TokenManager] Cleanup: ${result.affectedRows} logs eliminados (>60 días)`);
        }
    } catch (err) {
        console.error('[TokenManager] Error en cleanup logs:', err.message);
    }
}

/**
 * Worker solicita N tokens de una vez (batch) para acciones paralelas
 * Misma lógica que handleRequestToken pero LIMIT N en vez de LIMIT 1
 */
async function handleRequestTokenBatch(socket, data) {
    const { deck_id, action_type, tweet_id, tweet_url, count, request_id } = data;
    const batchSize = Math.min(Math.max(1, count || 10), 100); // Clamp 1-100

    if (!deck_id || !action_type) {
        socket.send(JSON.stringify({
            type: 'token_batch_assigned',
            request_id: request_id || null,
            tokens: [],
            reason: 'missing_params'
        }));
        return;
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const isView = action_type === 'view';
        let query = `
            SELECT xa.id, xa.nick, xa.auth_token, xa.ct0, xa.cookies_full
            FROM xchecker_accounts xa
            WHERE xa.deck_id = ?
              AND xa.estado = 'active'
              AND (xa.estado_salud NOT IN ('deslogueado', 'suspendido', 'muerto') OR xa.estado_salud IS NULL OR xa.estado_salud = 'desconocido')
              ${isView ? '' : 'AND xa.locked = 0'}
              AND xa.auth_token IS NOT NULL
              AND xa.ct0 IS NOT NULL
        `;
        const params = [deck_id];

        // Views pueden repetir token — el mismo token puede dar múltiples views
        if (tweet_id && !isView) {
            query += `
              AND xa.id NOT IN (
                  SELECT token_id FROM token_actions_log 
                  WHERE tweet_id = ? AND action_type = ? AND resultado = 'success'
              )
            `;
            params.push(tweet_id, action_type);
        }

        query += `
            ORDER BY xa.ultimo_uso ASC
            LIMIT ?
            ${isView ? '' : 'FOR UPDATE SKIP LOCKED'}
        `;
        params.push(batchSize);

        const [tokens] = await connection.query(query, params);

        if (tokens.length === 0) {
            // Diagnóstico batch
            let diagnostics = {};
            try {
                const [totalRows] = await connection.query(
                    `SELECT COUNT(*) as total FROM xchecker_accounts WHERE deck_id = ?`, [deck_id]
                );
                const [healthyRows] = await connection.query(
                    `SELECT COUNT(*) as total FROM xchecker_accounts WHERE deck_id = ? AND estado = 'active' AND auth_token IS NOT NULL AND ct0 IS NOT NULL AND (estado_salud NOT IN ('deslogueado', 'suspendido', 'muerto') OR estado_salud IS NULL OR estado_salud = 'desconocido') AND locked = 0`, [deck_id]
                );
                let usedCount = 0;
                if (tweet_id && action_type !== 'view') {
                    const [usedRows] = await connection.query(
                        `SELECT COUNT(*) as total FROM token_actions_log WHERE tweet_id = ? AND action_type = ? AND resultado = 'success'`, [tweet_id, action_type]
                    );
                    usedCount = usedRows[0].total;
                }
                diagnostics = { total_in_deck: totalRows[0].total, healthy_unlocked: healthyRows[0].total, already_used: usedCount };
                // console.log(`[TokenManager] No tokens batch para deck ${deck_id} (${action_type}): total=${diagnostics.total_in_deck} healthy_unlocked=${diagnostics.healthy_unlocked} used=${diagnostics.already_used}`);
            } catch (e) {}

            await connection.commit();
            socket.send(JSON.stringify({
                type: 'token_batch_assigned',
                request_id: request_id || null,
                tokens: [],
                reason: 'all_used_or_unhealthy',
                diagnostics
            }));
            return;
        }

        // Bloquear tokens del batch (views no necesita lock)
        if (action_type !== 'view') {
            const tokenIds = tokens.map(t => t.id);
            const placeholders = tokenIds.map(() => '?').join(',');
            await connection.query(
                `UPDATE xchecker_accounts SET locked = 1, locked_by = ?, locked_at = NOW() WHERE id IN (${placeholders})`,
                [socket.workerId || 'unknown', ...tokenIds]
            );
        }

        await connection.commit();

        // console.log(`[TokenManager] Batch: ${tokens.length} tokens asignados a worker ${socket.workerId} para ${action_type}`);

        socket.send(JSON.stringify({
            type: 'token_batch_assigned',
            request_id: request_id || null,
            tokens: tokens.map(t => ({
                token_id: t.id,
                nick: t.nick,
                auth_token: t.auth_token,
                ct0: t.ct0,
                cookies_full: t.cookies_full || null
            }))
        }));

    } catch (err) {
        await connection.rollback();
        console.error('[TokenManager] Error en batch:', err.message);
        socket.send(JSON.stringify({
            type: 'token_batch_assigned',
            request_id: request_id || null,
            tokens: [],
            reason: 'db_error'
        }));
    } finally {
        connection.release();
    }
}

/**
 * Worker reporta resultados de múltiples tokens de una vez (batch)
 * Procesa todos los reports en una sola transacción
 */
async function handleTokenReportBatch(socket, data) {
    const { reports } = data;
    if (!Array.isArray(reports) || reports.length === 0) return;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        for (const report of reports) {
            const { token_id, action_type, tweet_id, tweet_url, success, error_code, set_cookies } = report;
            if (!token_id) continue;

            // Insertar en token_actions_log
            if (tweet_id && action_type) {
                await connection.query(
                    `INSERT INTO token_actions_log (token_id, action_type, tweet_url, tweet_id, resultado, error_detail)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [token_id, action_type, tweet_url || '', tweet_id, success ? 'success' : 'fail', error_code || null]
                );
            }

            // Actualizar xchecker_accounts
            const isView = action_type === 'view';
            if (success) {
                await connection.query(
                    `UPDATE xchecker_accounts SET 
                        ultimo_uso = NOW(), fails_consecutivos = 0, estado_salud = 'activo'
                        ${isView ? '' : ", locked = 0, locked_by = NULL, locked_at = NULL"}
                    WHERE id = ?`,
                    [token_id]
                );
            } else {
                // Extraer código numérico si viene en JSON
                let numericCode = null;
                const errStr = error_code || '';
                try {
                    const parsed = JSON.parse(errStr);
                    if (parsed.errors && parsed.errors[0] && parsed.errors[0].code) {
                        numericCode = parsed.errors[0].code;
                    }
                } catch(e) {
                    const m = errStr.match(/\b(\d{3})\b/);
                    if (m) numericCode = parseInt(m[1]);
                }

                await errorRules.processError(connection, {
                    account_id: token_id,
                    action_id: null,
                    module: action_type,
                    error_code: numericCode,
                    error_message: errStr
                }, false);

                await connection.query(
                    `UPDATE xchecker_accounts SET ultimo_uso = NOW()
                        ${isView ? '' : ", locked = 0, locked_by = NULL, locked_at = NULL"}
                    WHERE id = ?`,
                    [token_id]
                );
            }
        }

        await connection.commit();
        // console.log(`[TokenManager] Batch report: ${reports.length} tokens procesados (worker ${socket.workerId})`);

    } catch (err) {
        await connection.rollback();
        console.error('[TokenManager] Error en batch report:', err.message);
    } finally {
        connection.release();
    }
}

module.exports = {
    handleRequestToken,
    handleTokenReport,
    handleRequestTokenBatch,
    handleTokenReportBatch,
    cleanupStaleLocks,
    cleanupOldLogs
};
