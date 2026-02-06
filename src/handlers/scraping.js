// src/handlers/scraping.js — Scraping job handler
// Tipos: xchecker_health (health check cuentas), xwarmer_nicks (scrape nicks + tweets)
const db = require('../db');
const { broadcastToPanels } = require('../state');

/**
 * Worker solicita un scraping job disponible
 * Responde con el job + todas las scraper accounts (para pool local)
 */
async function handleRequestScrapingJob(socket) {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [jobs] = await connection.query(
            `SELECT id, tipo, total, procesados, filtros
             FROM scraping_jobs
             WHERE estado = 'En Cola'
               AND tipo NOT IN ('unlock', 'login')
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE`,
            []
        );

        if (jobs.length === 0) {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'no_scraping_job' }));
            return;
        }

        const job = jobs[0];

        await connection.query(
            `UPDATE scraping_jobs SET estado = 'En Proceso', worker_id = ?, started_at = NOW() WHERE id = ?`,
            [socket.workerId, job.id]
        );

        // Cargar TODAS las scraper accounts activas
        const [scraperAccounts] = await connection.query(
            `SELECT id, auth_token, ct0, proxy
             FROM xspammer_accounts
             WHERE estado = 'active'
             ORDER BY last_use ASC`
        );

        await connection.commit();

        // console.log(`[Scraping] Job ${job.id} (${job.tipo}) asignado a worker ${socket.workerId} | ${scraperAccounts.length} scraper accounts`);

        socket.send(JSON.stringify({
            type: 'scraping_job',
            job: {
                id: job.id,
                tipo: job.tipo,
                total: job.total,
                procesados: job.procesados,
                filtros: typeof job.filtros === 'string' ? JSON.parse(job.filtros) : job.filtros
            },
            scraper_accounts: scraperAccounts
        }));
    } catch (err) {
        await connection.rollback();
        console.error('[Scraping] Error asignando job:', err.message);
        socket.send(JSON.stringify({ type: 'no_scraping_job', reason: 'db_error' }));
    } finally {
        connection.release();
    }
}

/**
 * Worker pide siguiente target para un scraping job
 * xchecker_health: devuelve cuenta de xchecker_accounts (con sus propios tokens)
 * xwarmer_nicks: devuelve nick de xwarmer_nicks
 */
async function handleScrapingNext(socket, data) {
    const { job_id } = data;
    if (!job_id) {
        socket.send(JSON.stringify({ type: 'scraping_done', job_id: 0, error: 'missing job_id' }));
        return;
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [jobRows] = await connection.query(
            `SELECT * FROM scraping_jobs WHERE id = ? FOR UPDATE`,
            [job_id]
        );

        if (jobRows.length === 0) {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'scraping_done', job_id, error: 'job not found' }));
            return;
        }

        const job = jobRows[0];

        // Safety: si ya se procesó todo, marcar completado
        if (job.procesados >= job.total && job.total > 0) {
            await connection.query(
                `UPDATE scraping_jobs SET estado = 'Completado', completed_at = COALESCE(completed_at, NOW()) WHERE id = ? AND estado != 'Completado'`,
                [job_id]
            );
            await connection.commit();
            // console.log(`[Scraping] Job ${job_id} ya alcanzó total (${job.procesados}/${job.total}), cerrando`);
            socket.send(JSON.stringify({
                type: 'scraping_done',
                job_id,
                total: job.procesados,
                exitosos: job.exitosos,
                errores: job.errores
            }));
            return;
        }

        // Parsear filtros (puede venir como string, object, o Buffer)
        let filtros = {};
        try {
            if (typeof job.filtros === 'string') {
                filtros = JSON.parse(job.filtros);
            } else if (Buffer.isBuffer(job.filtros)) {
                filtros = JSON.parse(job.filtros.toString('utf8'));
            } else if (job.filtros && typeof job.filtros === 'object') {
                filtros = job.filtros;
            }
        } catch (e) {
            console.error(`[Scraping] Error parseando filtros job ${job_id}:`, e.message);
        }

        if (job.tipo === 'xchecker_health') {
            // Buscar siguiente cuenta no procesada en este job
            let whereParts = ['xa.id > ?'];
            let whereParams = [filtros._last_id || 0];

            if (filtros.account_id) {
                whereParts.push('xa.id = ?');
                whereParams.push(filtros.account_id);
                // console.log(`[Scraping] Job ${job_id}: filtro account_id=${filtros.account_id}`);
            }
            if (filtros.nombre) {
                whereParts.push('xa.nombre = ?');
                whereParams.push(filtros.nombre);
            }
            if (filtros.estado) {
                whereParts.push('xa.estado = ?');
                whereParams.push(filtros.estado);
            }
            if (filtros.estado_salud) {
                whereParts.push('xa.estado_salud = ?');
                whereParams.push(filtros.estado_salud);
            }

            const [accounts] = await connection.query(
                `SELECT xa.id, xa.nick, xa.auth_token, xa.ct0, xa.twitter_user_id, 
                        xa.fails_consecutivos, xa.deck_id,
                        COALESCE(p.proxy_request, NULL) as deck_proxy
                 FROM xchecker_accounts xa
                 LEFT JOIN preconfigs p ON xa.deck_id = p.id
                 WHERE ${whereParts.join(' AND ')}
                 ORDER BY xa.id ASC
                 LIMIT 1`,
                whereParams
            );

            if (accounts.length === 0) {
                // Job completado
                await connection.query(
                    `UPDATE scraping_jobs SET estado = 'Completado', completed_at = NOW(), total = procesados WHERE id = ?`,
                    [job_id]
                );
                await connection.commit();

                // console.log(`[Scraping] Job ${job_id} completado: ${job.exitosos} ok, ${job.errores} errores`);
                socket.send(JSON.stringify({
                    type: 'scraping_done',
                    job_id,
                    total: job.procesados,
                    exitosos: job.exitosos,
                    errores: job.errores
                }));
                return;
            }

            const account = accounts[0];

            // Guardar last_id para paginación
            await connection.query(
                `UPDATE scraping_jobs SET filtros = JSON_SET(COALESCE(filtros, '{}'), '$._last_id', ?) WHERE id = ?`,
                [account.id, job_id]
            );

            await connection.commit();

            socket.send(JSON.stringify({
                type: 'scraping_target',
                job_id,
                target_type: 'xchecker_health',
                target: {
                    id: account.id,
                    nick: account.nick,
                    auth_token: account.auth_token,
                    ct0: account.ct0,
                    twitter_user_id: account.twitter_user_id,
                    fails_consecutivos: account.fails_consecutivos,
                    proxy: account.deck_proxy || null
                },
                progress: {
                    procesados: job.procesados,
                    total: job.total,
                    exitosos: job.exitosos,
                    errores: job.errores
                }
            }));

        } else if (job.tipo === 'xwarmer_nicks') {
            // Buscar siguiente nick no procesado
            let whereParts = ['id > ?'];
            let whereParams = [filtros._last_id || 0];

            if (filtros.nick_id) {
                whereParts.push('id = ?');
                whereParams.push(filtros.nick_id);
                // console.log(`[Scraping] Job ${job_id}: filtro nick_id=${filtros.nick_id}`);
            }
            if (filtros.grupo) {
                whereParts.push('grupo = ?');
                whereParams.push(filtros.grupo);
            }
            if (filtros.estado) {
                whereParts.push('estado = ?');
                whereParams.push(filtros.estado);
            }

            const [nicks] = await connection.query(
                `SELECT id, nick, userid, profile_img, location
                 FROM xwarmer_nicks
                 WHERE ${whereParts.join(' AND ')}
                 ORDER BY id ASC
                 LIMIT 1`,
                whereParams
            );

            if (nicks.length === 0) {
                await connection.query(
                    `UPDATE scraping_jobs SET estado = 'Completado', completed_at = NOW(), total = procesados WHERE id = ?`,
                    [job_id]
                );
                await connection.commit();

                // console.log(`[Scraping] Job ${job_id} completado: ${job.exitosos} ok, ${job.errores} errores`);
                socket.send(JSON.stringify({
                    type: 'scraping_done',
                    job_id,
                    total: job.procesados,
                    exitosos: job.exitosos,
                    errores: job.errores
                }));
                return;
            }

            const nick = nicks[0];

            await connection.query(
                `UPDATE scraping_jobs SET filtros = JSON_SET(COALESCE(filtros, '{}'), '$._last_id', ?) WHERE id = ?`,
                [nick.id, job_id]
            );

            await connection.commit();

            socket.send(JSON.stringify({
                type: 'scraping_target',
                job_id,
                target_type: 'xwarmer_nicks',
                target: {
                    id: nick.id,
                    nick: nick.nick,
                    userid: nick.userid
                },
                progress: {
                    procesados: job.procesados,
                    total: job.total,
                    exitosos: job.exitosos,
                    errores: job.errores
                }
            }));
        }

    } catch (err) {
        await connection.rollback();
        console.error(`[Scraping] Error en scraping_next para job ${job_id}:`, err.message);
        socket.send(JSON.stringify({ type: 'scraping_done', job_id, error: err.message }));
    } finally {
        connection.release();
    }
}

/**
 * Worker reporta resultado de un scraping individual
 */
async function handleScrapingResult(socket, data) {
    const { job_id, target_id, target_type, status, result, error_msg } = data;

    if (!job_id || !target_id) {
        socket.send(JSON.stringify({ type: 'scraping_result_ack', job_id, ok: false, error: 'missing params' }));
        return;
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const isSuccess = status === 'ok';

        // Actualizar contadores del job
        if (isSuccess) {
            await connection.query(
                `UPDATE scraping_jobs SET procesados = procesados + 1, exitosos = exitosos + 1 WHERE id = ?`,
                [job_id]
            );
        } else {
            await connection.query(
                `UPDATE scraping_jobs SET procesados = procesados + 1, errores = errores + 1 WHERE id = ?`,
                [job_id]
            );
        }

        // Aplicar resultado según tipo
        if (target_type === 'xchecker_health') {
            if (isSuccess && result) {
                // Actualizar cuenta con datos del perfil
                const r = result;
                const salud = r.estado_salud || 'activo';
                
                if (salud === 'activo' && r.profile) {
                    const p = r.profile;
                    await connection.query(
                        `UPDATE xchecker_accounts SET 
                         nick = ?, twitter_user_id = ?, estado = 'active', estado_salud = 'activo',
                         followers_count = ?, following_count = ?,
                         profile_img = CASE WHEN ? != '' THEN ? ELSE profile_img END,
                         location = ?, bio_descrip = ?, bio_link = ?,
                         fails_consecutivos = 0, ultimo_error = NULL, updated_at = NOW()
                         WHERE id = ?`,
                        [p.screen_name || r.nick, p.twitter_user_id, p.followers_count || 0, 
                         p.following_count || 0, p.profile_img || '', p.profile_img || '',
                         p.location || '', p.bio_descrip || '', p.bio_link || '', target_id]
                    );
                } else {
                    // Cuenta con problemas
                    const nuevoEstado = ['suspendido', 'locked', 'deslogueado'].includes(salud) ? 'inactive' : null;
                    if (nuevoEstado) {
                        await connection.query(
                            `UPDATE xchecker_accounts SET 
                             estado = ?, estado_salud = ?, ultimo_error = ?,
                             fails_consecutivos = fails_consecutivos + 1, updated_at = NOW()
                             WHERE id = ?`,
                            [nuevoEstado, salud, r.error_msg || 'unknown', target_id]
                        );
                    } else {
                        await connection.query(
                            `UPDATE xchecker_accounts SET 
                             estado_salud = ?, ultimo_error = ?,
                             fails_consecutivos = fails_consecutivos + 1, updated_at = NOW()
                             WHERE id = ?`,
                            [salud, r.error_msg || 'unknown', target_id]
                        );
                    }
                }
            } else {
                // Error genérico
                await connection.query(
                    `UPDATE xchecker_accounts SET 
                     ultimo_error = ?, fails_consecutivos = fails_consecutivos + 1, updated_at = NOW()
                     WHERE id = ?`,
                    [error_msg || 'scraping error', target_id]
                );
            }

        } else if (target_type === 'xwarmer_nicks') {
            if (isSuccess && result) {
                const r = result;
                if (r.tweets && r.tweets.length > 0) {
                    await connection.query(
                        `UPDATE xwarmer_nicks SET 
                         estado = 'active', userid = ?, profile_img = ?, location = ?,
                         bio_descrip = ?, bio_link = ?, tweets = ?, pineado = ?,
                         comentario = '', updated_at = NOW(), UserByScreenName = NOW()
                         WHERE id = ?`,
                        [r.userid || null, r.profile_img || '', r.location || '',
                         r.bio_descrip || '', r.bio_link || '', 
                         JSON.stringify(r.tweets), r.pineado ? 1 : 0, target_id]
                    );
                } else {
                    await connection.query(
                        `UPDATE xwarmer_nicks SET 
                         estado = 'inactive', userid = ?, profile_img = ?, location = ?,
                         bio_descrip = ?, bio_link = ?, tweets = '[]',
                         comentario = ?, updated_at = NOW(), UserByScreenName = NOW()
                         WHERE id = ?`,
                        [r.userid || null, r.profile_img || '', r.location || '',
                         r.bio_descrip || '', r.bio_link || '',
                         r.comentario || 'sin tweets válidos', target_id]
                    );
                }
            } else {
                await connection.query(
                    `UPDATE xwarmer_nicks SET 
                     estado = 'inactive', comentario = ?, tweets = '[]', updated_at = NOW()
                     WHERE id = ?`,
                    [error_msg || 'scraping error', target_id]
                );
            }
        }

        await connection.commit();
        socket.send(JSON.stringify({ type: 'scraping_result_ack', job_id, ok: true }));

    } catch (err) {
        await connection.rollback();
        console.error(`[Scraping] Error en scraping_result:`, err.message);
        socket.send(JSON.stringify({ type: 'scraping_result_ack', job_id, ok: false, error: err.message }));
    } finally {
        connection.release();
    }
}

/**
 * Worker reporta fallo de una cuenta scraper
 */
async function handleScraperAccountFail(socket, data) {
    const { scraper_id, error_type, error_msg } = data;
    // error_type: 'auth' | 'proxy' | 'rate_limit' | 'unknown'

    if (!scraper_id) return;

    try {
        let estado = 'failed';
        if (error_type === 'rate_limit') estado = 'rate_limited';
        if (error_type === 'proxy') estado = 'proxy_error';

        await db.query(
            `UPDATE xspammer_accounts SET 
             estado = ?, ultimo_error = ?, fails_consecutivos = fails_consecutivos + 1,
             updated_at = NOW()
             WHERE id = ?`,
            [estado, (error_msg || '').substring(0, 500), scraper_id]
        );

        // console.log(`[Scraping] Scraper account ${scraper_id} marcada como ${estado}: ${error_msg}`);

        socket.send(JSON.stringify({ type: 'scraper_fail_ack', scraper_id, ok: true }));
    } catch (err) {
        console.error(`[Scraping] Error actualizando scraper account ${scraper_id}:`, err.message);
    }
}

/**
 * Worker reporta éxito de una cuenta scraper (reset fails)
 */
async function handleScraperAccountSuccess(socket, data) {
    const { scraper_id } = data;
    if (!scraper_id) return;

    try {
        await db.query(
            `UPDATE xspammer_accounts SET 
             estado = 'active', fails_consecutivos = 0, last_use = NOW()
             WHERE id = ?`,
            [scraper_id]
        );
    } catch (err) {
        // Silent — no critical
    }
}

/**
 * Worker pide batch de targets — sin FOR UPDATE para evitar lock contention
 * La paginación por _last_id garantiza no duplicados
 */
async function handleScrapingNextBatch(socket, data) {
    const { job_id, batch_size = 20 } = data;
    if (!job_id) {
        socket.send(JSON.stringify({ type: 'scraping_done', job_id: 0, error: 'missing job_id' }));
        return;
    }

    const limit = Math.min(Math.max(batch_size, 1), 50);

    try {
        const [jobRows] = await db.query(
            `SELECT * FROM scraping_jobs WHERE id = ?`,
            [job_id]
        );

        if (jobRows.length === 0) {
            socket.send(JSON.stringify({ type: 'scraping_done', job_id, error: 'job not found' }));
            return;
        }

        const job = jobRows[0];

        if (job.procesados >= job.total && job.total > 0) {
            await db.query(
                `UPDATE scraping_jobs SET estado = 'Completado', total = procesados, completed_at = COALESCE(completed_at, NOW()) WHERE id = ? AND estado != 'Completado'`,
                [job_id]
            );
            socket.send(JSON.stringify({ type: 'scraping_done', job_id, total: job.procesados, exitosos: job.exitosos, errores: job.errores }));
            return;
        }

        let filtros = {};
        try {
            if (typeof job.filtros === 'string') filtros = JSON.parse(job.filtros);
            else if (Buffer.isBuffer(job.filtros)) filtros = JSON.parse(job.filtros.toString('utf8'));
            else if (job.filtros && typeof job.filtros === 'object') filtros = job.filtros;
        } catch (e) { /* ignore */ }

        let targets = [];

        if (job.tipo === 'xchecker_health') {
            let whereParts = ['xa.id > ?'];
            let whereParams = [filtros._last_id || 0];

            if (filtros.account_id) { whereParts.push('xa.id = ?'); whereParams.push(filtros.account_id); }
            if (filtros.nombre) { whereParts.push('xa.nombre = ?'); whereParams.push(filtros.nombre); }
            if (filtros.estado) { whereParts.push('xa.estado = ?'); whereParams.push(filtros.estado); }
            if (filtros.estado_salud) { whereParts.push('xa.estado_salud = ?'); whereParams.push(filtros.estado_salud); }

            const [rows] = await db.query(
                `SELECT xa.id, xa.nick, xa.auth_token, xa.ct0, xa.twitter_user_id,
                        xa.fails_consecutivos, xa.deck_id,
                        COALESCE(p.proxy_request, NULL) as deck_proxy
                 FROM xchecker_accounts xa
                 LEFT JOIN preconfigs p ON xa.deck_id = p.id
                 WHERE ${whereParts.join(' AND ')}
                 ORDER BY xa.id ASC
                 LIMIT ?`,
                [...whereParams, limit]
            );

            targets = rows.map(a => ({
                target_type: 'xchecker_health',
                target: {
                    id: a.id, nick: a.nick, auth_token: a.auth_token, ct0: a.ct0,
                    twitter_user_id: a.twitter_user_id, fails_consecutivos: a.fails_consecutivos,
                    proxy: a.deck_proxy || null
                }
            }));

            if (rows.length > 0) {
                await db.query(
                    `UPDATE scraping_jobs SET filtros = JSON_SET(COALESCE(filtros, '{}'), '$._last_id', ?) WHERE id = ?`,
                    [rows[rows.length - 1].id, job_id]
                );
            }

        } else if (job.tipo === 'xwarmer_nicks') {
            let whereParts = ['id > ?'];
            let whereParams = [filtros._last_id || 0];

            if (filtros.nick_id) { whereParts.push('id = ?'); whereParams.push(filtros.nick_id); }
            if (filtros.grupo) { whereParts.push('grupo = ?'); whereParams.push(filtros.grupo); }
            if (filtros.estado) { whereParts.push('estado = ?'); whereParams.push(filtros.estado); }

            const [rows] = await db.query(
                `SELECT id, nick, userid, profile_img, location
                 FROM xwarmer_nicks
                 WHERE ${whereParts.join(' AND ')}
                 ORDER BY id ASC
                 LIMIT ?`,
                [...whereParams, limit]
            );

            targets = rows.map(n => ({
                target_type: 'xwarmer_nicks',
                target: { id: n.id, nick: n.nick, userid: n.userid }
            }));

            if (rows.length > 0) {
                await db.query(
                    `UPDATE scraping_jobs SET filtros = JSON_SET(COALESCE(filtros, '{}'), '$._last_id', ?) WHERE id = ?`,
                    [rows[rows.length - 1].id, job_id]
                );
            }
        }

        if (targets.length === 0) {
            // No marcar Completado aquí — el Worker lo hará después de flushear resultados
            socket.send(JSON.stringify({ type: 'scraping_done', job_id, total: job.procesados, exitosos: job.exitosos, errores: job.errores }));
            return;
        }

        socket.send(JSON.stringify({
            type: 'scraping_batch',
            job_id,
            targets,
            progress: { procesados: job.procesados, total: job.total, exitosos: job.exitosos, errores: job.errores }
        }));

    } catch (err) {
        console.error(`[Scraping] Error en scraping_next_batch para job ${job_id}:`, err.message);
        try { socket.send(JSON.stringify({ type: 'scraping_done', job_id, error: err.message })); } catch (e) { /* ignore */ }
    }
}

/**
 * Worker reporta batch de resultados — 1 transacción para N resultados
 */
async function handleScrapingResultBatch(socket, data) {
    const { job_id, results } = data;
    if (!job_id || !results || !Array.isArray(results)) {
        socket.send(JSON.stringify({ type: 'scraping_result_batch_ack', job_id, ok: false, error: 'missing params' }));
        return;
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        let okCount = 0;
        let errCount = 0;

        for (const r of results) {
            const { target_id, target_type, status, result, error_msg } = r;
            if (!target_id) continue;

            const isSuccess = status === 'ok';
            if (isSuccess) okCount++; else errCount++;

            if (target_type === 'xchecker_health') {
                if (isSuccess && result) {
                    const salud = result.estado_salud || 'activo';
                    if (salud === 'activo' && result.profile) {
                        const p = result.profile;
                        await connection.query(
                            `UPDATE xchecker_accounts SET
                             nick = ?, twitter_user_id = ?, estado = 'active', estado_salud = 'activo',
                             followers_count = ?, following_count = ?,
                             profile_img = CASE WHEN ? != '' THEN ? ELSE profile_img END,
                             location = ?, bio_descrip = ?, bio_link = ?,
                             fails_consecutivos = 0, ultimo_error = NULL, updated_at = NOW()
                             WHERE id = ?`,
                            [p.screen_name || result.nick, p.twitter_user_id, p.followers_count || 0,
                             p.following_count || 0, p.profile_img || '', p.profile_img || '',
                             p.location || '', p.bio_descrip || '', p.bio_link || '', target_id]
                        );
                    } else {
                        const nuevoEstado = ['suspendido', 'locked', 'deslogueado'].includes(salud) ? 'inactive' : null;
                        if (nuevoEstado) {
                            await connection.query(
                                `UPDATE xchecker_accounts SET estado = ?, estado_salud = ?, ultimo_error = ?,
                                 fails_consecutivos = fails_consecutivos + 1, updated_at = NOW() WHERE id = ?`,
                                [nuevoEstado, salud, result.error_msg || 'unknown', target_id]
                            );
                        } else {
                            await connection.query(
                                `UPDATE xchecker_accounts SET estado_salud = ?, ultimo_error = ?,
                                 fails_consecutivos = fails_consecutivos + 1, updated_at = NOW() WHERE id = ?`,
                                [salud, result.error_msg || 'unknown', target_id]
                            );
                        }
                    }
                } else {
                    await connection.query(
                        `UPDATE xchecker_accounts SET ultimo_error = ?, fails_consecutivos = fails_consecutivos + 1, updated_at = NOW() WHERE id = ?`,
                        [error_msg || 'scraping error', target_id]
                    );
                }
            } else if (target_type === 'xwarmer_nicks') {
                if (isSuccess && result) {
                    if (result.tweets && result.tweets.length > 0) {
                        await connection.query(
                            `UPDATE xwarmer_nicks SET estado = 'active', userid = ?, profile_img = ?, location = ?,
                             bio_descrip = ?, bio_link = ?, tweets = ?, pineado = ?,
                             comentario = '', updated_at = NOW(), UserByScreenName = NOW() WHERE id = ?`,
                            [result.userid || null, result.profile_img || '', result.location || '',
                             result.bio_descrip || '', result.bio_link || '',
                             JSON.stringify(result.tweets), result.pineado ? 1 : 0, target_id]
                        );
                    } else {
                        await connection.query(
                            `UPDATE xwarmer_nicks SET estado = 'inactive', userid = ?, profile_img = ?, location = ?,
                             bio_descrip = ?, bio_link = ?, tweets = '[]',
                             comentario = ?, updated_at = NOW(), UserByScreenName = NOW() WHERE id = ?`,
                            [result.userid || null, result.profile_img || '', result.location || '',
                             result.bio_descrip || '', result.bio_link || '',
                             result.comentario || 'sin tweets válidos', target_id]
                        );
                    }
                } else {
                    await connection.query(
                        `UPDATE xwarmer_nicks SET estado = 'inactive', comentario = ?, tweets = '[]', updated_at = NOW() WHERE id = ?`,
                        [error_msg || 'scraping error', target_id]
                    );
                }
            }
        }

        // Actualizar contadores del job de una sola vez
        await connection.query(
            `UPDATE scraping_jobs SET procesados = procesados + ?, exitosos = exitosos + ?, errores = errores + ? WHERE id = ?`,
            [okCount + errCount, okCount, errCount, job_id]
        );

        // Obtener job actualizado para broadcast
        const [updatedJob] = await connection.query(
            `SELECT procesados, total, exitosos, errores, estado FROM scraping_jobs WHERE id = ?`,
            [job_id]
        );

        await connection.commit();

        // Broadcast xchecker_update para cada cuenta actualizada
        for (const r of results) {
            if (r.target_type === 'xchecker_health' && r.target_id) {
                const salud = r.result?.estado_salud || 'desconocido';
                broadcastToPanels(socket.userId, {
                    type: 'xchecker_update',
                    account_id: r.target_id,
                    estado_salud: salud,
                    fails_consecutivos: salud === 'activo' ? 0 : 1,
                    updated_at: new Date().toISOString()
                });
            }
        }

        // Broadcast job progress
        if (updatedJob.length > 0) {
            const j = updatedJob[0];
            broadcastToPanels(socket.userId, {
                type: 'xchecker_job_progress',
                job_id,
                procesados: j.procesados,
                total: j.total,
                exitosos: j.exitosos,
                errores: j.errores,
                estado: j.estado
            });
        }

        socket.send(JSON.stringify({ type: 'scraping_result_batch_ack', job_id, ok: true, processed: results.length }));

    } catch (err) {
        await connection.rollback();
        console.error(`[Scraping] Error en scraping_result_batch:`, err.message);
        socket.send(JSON.stringify({ type: 'scraping_result_batch_ack', job_id, ok: false, error: err.message }));
    } finally {
        connection.release();
    }
}

/**
 * Worker señala que terminó de procesar y flushear un job
 * Ahora sí marcamos Completado con los contadores reales
 */
async function handleScrapingJobComplete(socket, data) {
    const { job_id } = data;
    if (!job_id) return;

    try {
        await db.query(
            `UPDATE scraping_jobs SET estado = 'Completado', total = procesados, completed_at = COALESCE(completed_at, NOW()) WHERE id = ? AND estado != 'Completado'`,
            [job_id]
        );

        // Obtener stats finales para broadcast
        const [jobRows] = await db.query(
            `SELECT procesados, total, exitosos, errores FROM scraping_jobs WHERE id = ?`,
            [job_id]
        );

        if (jobRows.length > 0) {
            const j = jobRows[0];
            broadcastToPanels(socket.userId, {
                type: 'xchecker_job_progress',
                job_id,
                procesados: j.procesados,
                total: j.total,
                exitosos: j.exitosos,
                errores: j.errores,
                estado: 'Completado'
            });
        }

        socket.send(JSON.stringify({ type: 'scraping_job_complete_ack', job_id, ok: true }));
    } catch (err) {
        console.error(`[Scraping] Error en scraping_job_complete:`, err.message);
    }
}

module.exports = {
    handleRequestScrapingJob,
    handleScrapingNext,
    handleScrapingNextBatch,
    handleScrapingResult,
    handleScrapingResultBatch,
    handleScrapingJobComplete,
    handleScraperAccountFail,
    handleScraperAccountSuccess
};
