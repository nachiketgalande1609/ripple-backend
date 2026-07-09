-- E2E Encryption Migration
-- Run this against your database before deploying the E2E encryption changes.

-- 1. Stores one public key per device per user.
--    A user logged into 2 devices will have 2 rows.
CREATE TABLE IF NOT EXISTS `user_keys` (
  `key_id`     INT NOT NULL AUTO_INCREMENT,
  `user_id`    INT NOT NULL,
  `device_id`  VARCHAR(255) NOT NULL,
  `public_key` TEXT NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`key_id`),
  UNIQUE KEY `user_device` (`user_id`, `device_id`),
  CONSTRAINT `fk_user_keys_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. Stores the IV and per-device encrypted AES keys alongside each message.
--    Structure: { "iv": "<base64>", "keys": [{ "deviceId": "...", "encryptedKey": "..." }] }
--    NULL means the message was sent before E2E was enabled (legacy plaintext).
ALTER TABLE `messages`
  ADD COLUMN `encrypted_keys` JSON DEFAULT NULL;
