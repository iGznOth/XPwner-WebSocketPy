// src/handlers/scraping.js — Scraping job handler
// Tipos: xchecker_health (health check cuentas), xwarmer_nicks (scrape nicks + tweets)
const db = require('../db');

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

        console.log(`[Scraping] Job ${job.id} (${job.tipo}) asignado a worker ${socket.workerId} | ${scraperAccounts.length} scraper accounts`);

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
        const filtros = typeof job.filtros === 'string' ? JSON.parse(job.filtros) : (job.filtros || {});

        if (job.tipo === 'xchecker_health') {
            // Buscar siguiente cuenta no procesada en este job
            const [accounts] = await connection.query(
                `SELECT xa.id, xa.nick, xa.auth_token, xa.ct0, xa.twitter_user_id, 
                        xa.fails_consecutivos, xa.deck_id,
                        COALESCE(p.proxy_request, NULL) as deck_proxy
                 FROM xchecker_accounts xa
                 LEFT JOIN preconfigs p ON xa.deck_id = p.id
                 WHERE xa.id > ?
                   ${filtros.deck_id ? 'AND xa.deck_id = ?' : ''}
                   ${filtros.estado ? 'AND xa.estado = ?' : ''}
                 ORDER BY xa.id ASC
                 LIMIT 1`,
                [
                    job.procesados > 0 ? (filtros._last_id || 0) : 0,
                    ...(filtros.deck_id ? [filtros.deck_id] : []),
                    ...(filtros.estado ? [filtros.estado] : [])
                ].filter(v => v !== undefined)
            );

            if (accounts.length === 0) {
                // Job completado
                await connection.query(
                    `UPDATE scraping_jobs SET estado = 'Completado', completed_at = NOW(), total = procesados WHERE id = ?`,
                    [job_id]
                );
                await connection.commit();

                console.log(`[Scraping] Job ${job_id} completado: ${job.exitosos} ok, ${job.errores} errores`);
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
            const [nicks] = await connection.query(
                `SELECT id, nick, userid, profile_img, location
                 FROM xwarmer_nicks
                 WHERE id > ?
                   ${filtros.grupo ? 'AND grupo = ?' : ''}
                   ${filtros.estado ? 'AND estado = ?' : ''}
                 ORDER BY id ASC
                 LIMIT 1`,
                [
                    filtros._last_id || 0,
                    ...(filtros.grupo ? [filtros.grupo] : []),
                    ...(filtros.estado ? [filtros.estado] : [])
                ].filter(v => v !== undefined)
            );

            if (nicks.length === 0) {
                await connection.query(
                    `UPDATE scraping_jobs SET estado = 'Completado', completed_at = NOW(), total = procesados WHERE id = ?`,
                    [job_id]
                );
                await connection.commit();

                console.log(`[Scraping] Job ${job_id} completado: ${job.exitosos} ok, ${job.errores} errores`);
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
                         followers_count = ?, following_count = ?, profile_img = ?, 
                         location = ?, bio_descrip = ?, bio_link = ?,
                         fails_consecutivos = 0, ultimo_error = NULL, updated_at = NOW()
                         WHERE id = ?`,
                        [p.screen_name || r.nick, p.twitter_user_id, p.followers_count || 0, 
                         p.following_count || 0, p.profile_img || '', p.location || '', 
                         p.bio_descrip || '', p.bio_link || '', target_id]
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

        console.log(`[Scraping] Scraper account ${scraper_id} marcada como ${estado}: ${error_msg}`);

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

module.exports = {
    handleRequestScrapingJob,
    handleScrapingNext,
    handleScrapingResult,
    handleScraperAccountFail,
    handleScraperAccountSuccess
};
