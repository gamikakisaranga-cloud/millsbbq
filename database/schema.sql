-- Mills Smoke & Grill — MySQL schema
-- Run once against an empty database, e.g.:
--   npm run db:setup

CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  email         VARCHAR(190)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NOT NULL,
  first_name    VARCHAR(100)  NOT NULL,
  last_name     VARCHAR(100)  NOT NULL DEFAULT '',
  phone         VARCHAR(40)   NULL,
  profile_picture VARCHAR(500) NULL,
  date_of_birth DATE          NULL,
  address       VARCHAR(255)  NULL,
  role          ENUM('CUSTOMER','ADMIN') NOT NULL DEFAULT 'CUSTOMER',
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_addresses (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  user_id       CHAR(36)      NOT NULL,
  label         VARCHAR(80)   NOT NULL DEFAULT 'Shipping address',
  first_name    VARCHAR(100)  NOT NULL,
  last_name     VARCHAR(100)  NOT NULL DEFAULT '',
  address       VARCHAR(255)  NOT NULL,
  city          VARCHAR(100)  NOT NULL,
  state         VARCHAR(100)  NULL,
  postcode      VARCHAR(20)   NOT NULL,
  country       VARCHAR(100)  NOT NULL DEFAULT 'Australia',
  is_default_shipping TINYINT(1) NOT NULL DEFAULT 0,
  is_default_billing  TINYINT(1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_addresses_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_methods (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  user_id       CHAR(36)      NOT NULL,
  provider      VARCHAR(40)   NOT NULL,
  label         VARCHAR(120)  NOT NULL,
  provider_token VARCHAR(255) NULL,
  is_default    TINYINT(1)    NOT NULL DEFAULT 0,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_methods_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_payment_methods_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
  id           VARCHAR(80)   NOT NULL PRIMARY KEY,
  slug         VARCHAR(80)   NOT NULL UNIQUE,
  name         VARCHAR(150)  NOT NULL,
  description  TEXT          NOT NULL,
  price_cents  INT           NOT NULL,
  stock        INT           NOT NULL DEFAULT 0,
  is_active    TINYINT(1)    NOT NULL DEFAULT 1,
  metadata     JSON          NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wishlists (
  user_id       CHAR(36)      NOT NULL,
  product_id    VARCHAR(80)   NOT NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id),
  CONSTRAINT fk_wishlist_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wishlist_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  order_number     VARCHAR(40)   NOT NULL UNIQUE,
  user_id          CHAR(36)      NULL,
  email            VARCHAR(190)  NOT NULL,
  first_name       VARCHAR(100)  NOT NULL,
  last_name        VARCHAR(100)  NOT NULL,
  phone            VARCHAR(40)   NULL,
  address          VARCHAR(255)  NOT NULL,
  city             VARCHAR(100)  NOT NULL,
  state            VARCHAR(100)  NULL,
  postcode         VARCHAR(20)   NOT NULL,
  country          VARCHAR(100)  NOT NULL DEFAULT 'Australia',
  subtotal_cents   INT           NOT NULL,
  shipping_cents   INT           NOT NULL,
  total_cents      INT           NOT NULL,
  currency         VARCHAR(10)   NOT NULL DEFAULT 'AUD',
  status           ENUM('PENDING','PAID','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED') NOT NULL DEFAULT 'PENDING',
  payment_provider VARCHAR(20) NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_requests (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  order_id      CHAR(36)      NOT NULL,
  user_id       CHAR(36)      NOT NULL,
  type          ENUM('CANCEL','RETURN','REFUND') NOT NULL,
  reason        VARCHAR(500)  NULL,
  status        ENUM('REQUESTED','APPROVED','DECLINED') NOT NULL DEFAULT 'REQUESTED',
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_requests_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_requests_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_order_requests_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_items (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  order_id       CHAR(36)      NOT NULL,
  product_id     VARCHAR(80)   NOT NULL,
  name_snapshot  VARCHAR(150)  NOT NULL,
  price_cents    INT           NOT NULL,
  quantity       INT           NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  order_id            CHAR(36)      NOT NULL,
  provider            VARCHAR(20) NOT NULL,
  provider_payment_id VARCHAR(190)  NOT NULL UNIQUE,
  status              ENUM('PENDING','AUTHORIZED','PAID','FAILED','REFUNDED') NOT NULL,
  amount_cents        INT           NOT NULL,
  currency            VARCHAR(10)   NOT NULL DEFAULT 'AUD',
  raw_event           JSON          NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS delivery_zones (
  id          CHAR(36)      NOT NULL PRIMARY KEY,
  name        VARCHAR(120)  NOT NULL,
  city        VARCHAR(100)  NOT NULL UNIQUE,
  price_cents INT           NOT NULL,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  `key`      VARCHAR(80) NOT NULL PRIMARY KEY,
  value      JSON        NOT NULL,
  updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activity_log (
  id         CHAR(36)      NOT NULL PRIMARY KEY,
  user_id    CHAR(36)      NULL,
  action     VARCHAR(60)   NOT NULL,
  entity     VARCHAR(60)   NOT NULL,
  entity_id  VARCHAR(80)   NULL,
  metadata   JSON          NULL,
  ip_address VARCHAR(64)   NULL,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_activity_created_at (created_at),
  INDEX idx_activity_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
