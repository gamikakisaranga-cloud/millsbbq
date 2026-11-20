CREATE TABLE IF NOT EXISTS password_resets (
 id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
 expires_at DATETIME NOT NULL, used_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, INDEX idx_password_reset_user(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE newsletter_subscribers ADD COLUMN unsubscribe_token_hash CHAR(64) NULL;
CREATE TABLE IF NOT EXISTS recipes (
 id CHAR(36) PRIMARY KEY, title VARCHAR(180) NOT NULL, slug VARCHAR(200) NOT NULL UNIQUE,
 summary VARCHAR(500) NULL, body TEXT NULL, prep_time VARCHAR(80) NULL, cook_time VARCHAR(80) NULL,
 servings VARCHAR(80) NULL, rub_pairing VARCHAR(150) NULL, main_image_url VARCHAR(1000) NULL,
 gallery_images JSON NULL, ingredients JSON NULL, method JSON NULL,
 status ENUM('DRAFT','PUBLISHED') NOT NULL DEFAULT 'DRAFT', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX idx_recipes_status(status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE users ADD COLUMN marketing_opt_in TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN marketing_unsubscribe_token_hash CHAR(64) NULL;
ALTER TABLE users ADD COLUMN marketing_opt_in_at DATETIME NULL;
CREATE TABLE IF NOT EXISTS marketing_unsubscribe_tokens (
 id CHAR(36) PRIMARY KEY, email VARCHAR(190) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
 used_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 INDEX idx_marketing_unsubscribe_email(email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
