const { promisePool: db } = require('./db');

async function run() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS \`groups\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(500),
        profile_picture VARCHAR(500),
        created_by INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('groups table OK');

    await db.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL,
        user_id INT NOT NULL,
        role ENUM('admin','member') DEFAULT 'member',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_member (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('group_members table OK');

    await db.query(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL,
        sender_id INT NOT NULL,
        message_text TEXT,
        file_url VARCHAR(500),
        file_name VARCHAR(255),
        file_size BIGINT,
        timestamp DATETIME,
        reply_to INT,
        media_width INT,
        media_height INT,
        reactions JSON,
        post_id INT,
        FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('group_messages table OK');
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

run();
