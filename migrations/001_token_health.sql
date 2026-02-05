-- Migración: Tabla token_health para tracking de salud de tokens
-- Ejecutar en la base de datos de XPwner

CREATE TABLE IF NOT EXISTS `token_health` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `cuentas_id` INT NOT NULL,
    `auth_token` VARCHAR(255) NOT NULL,
    `fails_consecutivos` INT DEFAULT 0,
    `ultimo_error` VARCHAR(500) DEFAULT NULL,
    `ultimo_uso` DATETIME DEFAULT NULL,
    `estado` ENUM('activo', 'enfermo', 'muerto') DEFAULT 'activo',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_cuenta_token` (`cuentas_id`, `auth_token`),
    INDEX `idx_estado` (`estado`),
    INDEX `idx_cuenta_estado` (`cuentas_id`, `estado`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla action_log para trazabilidad completa de acciones
CREATE TABLE IF NOT EXISTS `action_log` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `action_id` INT NOT NULL,
    `source` ENUM('panel', 'websocket', 'worker') NOT NULL,
    `evento` VARCHAR(100) NOT NULL,
    `detalle` TEXT DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_action_id` (`action_id`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
