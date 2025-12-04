// daily_muse_backend/index.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const schedule = require('node-schedule');
// const express = require('express');
const path = require('path');
const fs = require('fs');


const app = express();
app.use(cors());
app.use(bodyParser.json());

const webPath = path.join(path.dirname(process.execPath), 'web');
app.use(express.static(webPath));

// ==================== 数据库初始化 ====================
// const dbPath = path.join(__dirname, "daily_muse.db");
// const dbPath = path.join(path.dirname(require.main.filename), 'daily_muse.db');
const dbDir = path.dirname(process.execPath);
const dbPath = path.join(dbDir, 'daily_muse.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('数据库连接成功');
    initializeDatabase();
  }
});

// 初始化数据库表
function initializeDatabase() {
  db.serialize(() => {
    // 用户表
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 文章表
    db.run(`
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        is_today INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME
      )
    `);

    // 名言表
    db.run(`
      CREATE TABLE IF NOT EXISTS quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        category TEXT,
        is_today INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME
      )
    `);

    // 用户通知设置表
    db.run(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        article_enabled INTEGER DEFAULT 1,
        quote_enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // ==================== 新增：用户收藏表 ====================
    db.run(`
      CREATE TABLE IF NOT EXISTS user_favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        item_type TEXT NOT NULL, -- 'article' 或 'quote'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (username) REFERENCES users(username)
      )
    `);
    
    // 为收藏表创建唯一索引，防止重复收藏
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_item 
      ON user_favorites (username, item_id, item_type)
    `);
    // ========================================================

    console.log('数据库表初始化完成');
  });
}

// ==================== 工具函数 ====================
// ... (generateToken, verifyToken, getUserInfo, authenticateToken, verifyAdmin 保持不变)
// 生成简单的token
function generateToken(username) {
  return Buffer.from(username + ':' + Date.now()).toString('base64');
}

// 验证token（简单实现，实际应使用JWT）
function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [username] = decoded.split(':');
    return username;
  } catch (e) {
    return null;
  }
}

// 获取用户信息（用于验证管理员身份）
function getUserInfo(username, callback) {
  db.get(
    'SELECT * FROM users WHERE username = ?',
    [username],
    (err, user) => {
      callback(err, user);
    }
  );
}

// 身份认证中间件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: '未提供token' });
  }

  const username = verifyToken(token);
  if (!username) {
    return res.status(403).json({ message: 'token无效或已过期' });
  }

  req.username = username;
  next();
}

// 管理员验证中间件
function verifyAdmin(req, res, next) {
  getUserInfo(req.username, (err, user) => {
    if (err || !user) {
      return res.status(403).json({ message: '用户不存在' });
    }
    if (!user.is_admin) {
      return res.status(403).json({ message: '无权访问，仅管理员可用' });
    }
    next();
  });
}
// ==================== 管理员初始化接口 ====================
// ... (app.post('/admin/init', ...) 保持不变)
// 默认初始化密钥，可通过环境变量覆盖
const ADMIN_INIT_SECRET = process.env.ADMIN_INIT_SECRET || 'daily_muse_secret_2024';

// 初始化管理员账户（仅当系统中没有管理员时可用）
app.post('/admin/init', (req, res) => {
  const { username, password, secret_key } = req.body;

  // 验证密钥
  if (secret_key !== ADMIN_INIT_SECRET) {
    return res.status(403).json({ message: '密钥错误，无法初始化管理员' });
  }

  // 验证用户名和密码
  if (!username || !password) {
    return res.status(400).json({ message: '用户名或密码不能为空' });
  }

  // 检查是否已存在管理员
  db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', (err, result) => {
    if (err) {
      return res.status(500).json({ message: '检查管理员失败' });
    }

    // 如果已存在管理员，拒绝初始化
    if (result.count > 0) {
      return res.status(403).json({
        message: '系统中已存在管理员，无法进行初始化。如需创建更多管理员，请使用管理员账户操作数据库。'
      });
    }

    // 检查用户名是否已存在
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
      if (user) {
        return res.status(400).json({ message: '用户已存在' });
      }

      // 创建管理员账户
      db.run(
        'INSERT INTO users (username, password, is_admin) VALUES (?, ?, 1)',
        [username, password],
        function (err) {
          if (err) {
            return res.status(500).json({ message: '创建管理员失败' });
          }

          // 创建通知设置记录
          db.run(
            'INSERT INTO notification_settings (username) VALUES (?)',
            [username],
            (err) => {
              if (err) {
                console.error('创建通知设置失败:', err);
              }

              const token = generateToken(username);
              console.log(`✅ 管理员账户 "${username}" 创建成功`);
              res.json({
                message: '管理员账户创建成功',
                token: token,
                username: username,
                is_admin: true
              });
            }
          );
        }
      );
    });
  });
});
// ==================== 用户认证相关接口 ====================
// ... (app.post('/register', ...) 和 app.post('/login', ...) 保持不变)
// 注册接口
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: '用户名或密码不能为空' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (user) {
      return res.status(400).json({ message: '用户已存在' });
    }

    db.run(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, password],
      function (err) {
        if (err) {
          return res.status(500).json({ message: '注册失败' });
        }

        // 创建通知设置记录
        db.run(
          'INSERT INTO notification_settings (username) VALUES (?)',
          [username],
          (err) => {
            if (err) {
              console.error('创建通知设置失败:', err);
            }
            const token = generateToken(username);
            res.json({
              message: '注册成功',
              token: token,
              username: username
            });
          }
        );
      }
    );
  });
});

// 登录接口
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(
    'SELECT * FROM users WHERE username = ? AND password = ?',
    [username, password],
    (err, user) => {
      if (!user) {
        return res.status(401).json({ message: '用户名或密码错误' });
      }
      const token = generateToken(username);
      res.json({
        message: '登录成功',
        token: token,
        username: username,
        is_admin: user.is_admin === 1
      });
    }
  );
});
// ==================== 文章相关接口 ====================

// 获取今日文章 (修改：增加 is_favorited 字段)
app.get('/article/today', authenticateToken, (req, res) => {
  db.get(
    'SELECT * FROM articles WHERE is_today = 1 ORDER BY published_at DESC LIMIT 1',
    (err, article) => {
      if (err) {
        return res.status(500).json({ message: '获取文章失败' });
      }
      if (!article) {
        return res.status(404).json({ message: '暂无今日文章' });
      }

      // 检查用户是否收藏
      db.get(
        'SELECT 1 FROM user_favorites WHERE username = ? AND item_id = ? AND item_type = ?',
        [req.username, article.id, 'article'],
        (err, fav) => {
          if (err) {
             // 即使查询失败，也应返回文章
            console.error('查询收藏失败:', err);
            article.is_favorited = false;
          } else {
            article.is_favorited = !!fav; // !!fav 将 (null 或 {1:1}) 转为 (false 或 true)
          }
          
          res.json({
            message: '获取今日文章成功',
            data: article
          });
        }
      );
    }
  );
});

// ... (app.get('/articles', ...), app.post('/admin/article/add', ...), app.put('/admin/article/:id', ...), app.delete('/admin/article/:id', ...) 保持不变)
// 获取所有文章（分页）
app.get('/articles', authenticateToken, (req, res) => {
  const page = req.query.page || 1;
  const limit = req.query.limit || 10;
  const offset = (page - 1) * limit;

  db.all(
    'SELECT * FROM articles ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset],
    (err, articles) => {
      if (err) {
        return res.status(500).json({ message: '获取文章列表失败' });
      }
      res.json({
        message: '获取文章列表成功',
        data: articles,
        page: page,
        limit: limit
      });
    }
  );
});

// 添加文章（管理员）
app.post('/admin/article/add', authenticateToken, verifyAdmin, (req, res) => {
  const { title, content, author } = req.body;

  if (!title || !content || !author) {
    return res.status(400).json({ message: '标题、内容、作者不能为空' });
  }

  db.run(
    'INSERT INTO articles (title, content, author, published_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
    [title, content, author],
    function (err) {
      if (err) {
        return res.status(500).json({ message: '添加文章失败' });
      }
      res.json({
        message: '文章添加成功',
        data: {
          id: this.lastID,
          title,
          content,
          author
        }
      });
    }
  );
});

// 更新文章（管理员）
app.put('/admin/article/:id', authenticateToken, verifyAdmin, (req, res) => {
  const { id } = req.params;
  const { title, content, author } = req.body;

  db.run(
    'UPDATE articles SET title = ?, content = ?, author = ? WHERE id = ?',
    [title, content, author, id],
    function (err) {
      if (err) {
        return res.status(500).json({ message: '更新文章失败' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ message: '文章不存在' });
      }
      res.json({ message: '文章更新成功' });
    }
  );
});

// 删除文章（管理员）
app.delete('/admin/article/:id', authenticateToken, verifyAdmin, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM articles WHERE id = ?', [id], function (err) {
    if (err) {
      return res.status(500).json({ message: '删除文章失败' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ message: '文章不存在' });
    }
    res.json({ message: '文章删除成功' });
  });
});
// ==================== 名言相关接口 ====================

// 获取今日名言 (修改：增加 is_favorited 字段)
app.get('/quote/today', authenticateToken, (req, res) => {
  db.get(
    'SELECT * FROM quotes WHERE is_today = 1 ORDER BY published_at DESC LIMIT 1',
    (err, quote) => {
      if (err) {
        return res.status(500).json({ message: '获取名言失败' });
      }
      if (!quote) {
        return res.status(404).json({ message: '暂无今日名言' });
      }

      // 检查用户是否收藏
      db.get(
        'SELECT 1 FROM user_favorites WHERE username = ? AND item_id = ? AND item_type = ?',
        [req.username, quote.id, 'quote'],
        (err, fav) => {
          if (err) {
            console.error('查询收藏失败:', err);
            quote.is_favorited = false;
          } else {
            quote.is_favorited = !!fav;
          }
          
          res.json({
            message: '获取今日名言成功',
            data: quote
          });
        }
      );
    }
  );
});

// ... (app.get('/quotes', ...), app.post('/admin/quote/add', ...), app.put('/admin/quote/:id', ...), app.delete('/admin/quote/:id', ...) 保持不变)
// 获取所有名言（分页）
app.get('/quotes', authenticateToken, (req, res) => {
  const page = req.query.page || 1;
  const limit = req.query.limit || 10;
  const offset = (page - 1) * limit;

  db.all(
    'SELECT * FROM quotes ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset],
    (err, quotes) => {
      if (err) {
        return res.status(500).json({ message: '获取名言列表失败' });
      }
      res.json({
        message: '获取名言列表成功',
        data: quotes,
        page: page,
        limit: limit
      });
    }
  );
});

// 添加名言（管理员）
app.post('/admin/quote/add', authenticateToken, verifyAdmin, (req, res) => {
  const { content, author, category } = req.body;

  if (!content || !author) {
    return res.status(400).json({ message: '名言内容和作者不能为空' });
  }

  db.run(
    'INSERT INTO quotes (content, author, category, published_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
    [content, author, category || ''],
    function (err) {
      if (err) {
        return res.status(500).json({ message: '添加名言失败' });
      }
      res.json({
        message: '名言添加成功',
        data: {
          id: this.lastID,
          content,
          author,
          category
        }
      });
    }
  );
});

// 更新名言（管理员）
app.put('/admin/quote/:id', authenticateToken, verifyAdmin, (req, res) => {
  const { id } = req.params;
  const { content, author, category } = req.body;

  db.run(
    'UPDATE quotes SET content = ?, author = ?, category = ? WHERE id = ?',
    [content, author, category, id],
    function (err) {
      if (err) {
        return res.status(500).json({ message: '更新名言失败' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ message: '名言不存在' });
      }
      res.json({ message: '名言更新成功' });
    }
  );
});

// 删除名言（管理员）
app.delete('/admin/quote/:id', authenticateToken, verifyAdmin, (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM quotes WHERE id = ?', [id], function (err) {
    if (err) {
      return res.status(500).json({ message: '删除名言失败' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ message: '名言不存在' });
    }
    res.json({ message: '名言删除成功' });
  });
});
// ==================== 用户通知设置相关接口 ====================
// ... (app.get('/notification/settings', ...) 和 app.post('/notification/settings', ...) 保持不变)
// 获取用户通知设置
app.get('/notification/settings', authenticateToken, (req, res) => {
  db.get(
    'SELECT * FROM notification_settings WHERE username = ?',
    [req.username],
    (err, settings) => {
      if (err) {
        return res.status(500).json({ message: '获取通知设置失败' });
      }
      if (!settings) {
        // 如果不存在，创建默认设置
        db.run(
          'INSERT INTO notification_settings (username) VALUES (?)',
          [req.username],
          (err) => {
            if (err) {
              return res.status(500).json({ message: '创建通知设置失败' });
            }
            res.json({
              message: '获取通知设置成功',
              data: {
                username: req.username,
                article_enabled: 1,
                quote_enabled: 1
              }
            });
          }
        );
      } else {
        res.json({
          message: '获取通知设置成功',
          data: {
            username: settings.username,
            article_enabled: settings.article_enabled,
            quote_enabled: settings.quote_enabled
          }
        });
      }
    }
  );
});

// 更新用户通知设置
app.post('/notification/settings', authenticateToken, (req, res) => {
  const { article_enabled, quote_enabled } = req.body;

  db.run(
    'UPDATE notification_settings SET article_enabled = ?, quote_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?',
    [article_enabled ? 1 : 0, quote_enabled ? 1 : 0, req.username],
    function (err) {
      if (err) {
        return res.status(500).json({ message: '更新通知设置失败' });
      }
      if (this.changes === 0) {
        // 如果用户不存在，创建新的设置
        db.run(
          'INSERT INTO notification_settings (username, article_enabled, quote_enabled) VALUES (?, ?, ?)',
          [req.username, article_enabled ? 1 : 0, quote_enabled ? 1 : 0],
          (err) => {
            if (err) {
              return res.status(500).json({ message: '创建通知设置失败' });
            }
            res.json({
              message: '通知设置更新成功',
              data: {
                username: req.username,
                article_enabled: article_enabled ? 1 : 0,
                quote_enabled: quote_enabled ? 1 : 0
              }
            });
          }
        );
      } else {
        res.json({
          message: '通知设置更新成功',
          data: {
            username: req.username,
            article_enabled: article_enabled ? 1 : 0,
            quote_enabled: quote_enabled ? 1 : 0
          }
        });
      }
    }
  );
});
// ==================== 新增：收藏相关接口 ====================

// 切换收藏状态（添加/移除）
app.post('/favorite/toggle', authenticateToken, (req, res) => {
  const { item_id, item_type } = req.body;
  const { username } = req;

  if (!item_id || !item_type) {
    return res.status(400).json({ message: '缺少 item_id 或 item_type' });
  }

  if (item_type !== 'article' && item_type !== 'quote') {
    return res.status(400).json({ message: '无效的 item_type' });
  }

  // 1. 检查是否已收藏
  db.get(
    'SELECT id FROM user_favorites WHERE username = ? AND item_id = ? AND item_type = ?',
    [username, item_id, item_type],
    (err, favorite) => {
      if (err) {
        return res.status(500).json({ message: '查询收藏失败' });
      }

      if (favorite) {
        // 2a. 已收藏 -> 删除
        db.run(
          'DELETE FROM user_favorites WHERE id = ?',
          [favorite.id],
          (err) => {
            if (err) {
              return res.status(500).json({ message: '取消收藏失败' });
            }
            res.json({
              message: '已取消收藏',
              favorited: false
            });
          }
        );
      } else {
        // 2b. 未收藏 -> 添加
        db.run(
          'INSERT INTO user_favorites (username, item_id, item_type) VALUES (?, ?, ?)',
          [username, item_id, item_type],
          (err) => {
            if (err) {
              return res.status(500).json({ message: '添加收藏失败' });
            }
            res.json({
              message: '已添加收藏',
              favorited: true
            });
          }
        );
      }
    }
  );
});

// 获取用户的所有收藏
app.get('/favorites', authenticateToken, (req, res) => {
  const { username } = req;
  const responseData = {
    articles: [],
    quotes: []
  };

  // 1. 获取收藏的文章
  db.all(
    `SELECT a.* FROM articles a 
     JOIN user_favorites f ON a.id = f.item_id 
     WHERE f.username = ? AND f.item_type = 'article'
     ORDER BY f.created_at DESC`,
    [username],
    (err, articles) => {
      if (err) {
        return res.status(500).json({ message: '获取收藏的文章失败' });
      }
      responseData.articles = articles;

      // 2. 获取收藏的名言
      db.all(
        `SELECT q.* FROM quotes q
         JOIN user_favorites f ON q.id = f.item_id
         WHERE f.username = ? AND f.item_type = 'quote'
         ORDER BY f.created_at DESC`,
        [username],
        (err, quotes) => {
          if (err) {
            return res.status(500).json({ message: '获取收藏的名言失败' });
          }
          responseData.quotes = quotes;

          // 3. 返回合并的结果
          res.json({
            message: '获取收藏列表成功',
            data: responseData
          });
        }
      );
    }
  );
});

// ==================== 定时任务 ====================
// ... (schedule.scheduleJob(...) 保持不变)
// 每天午夜0:00执行一次，更新今日文章和名言
schedule.scheduleJob('0 0 * * *', () => {
  console.log('执行定时任务：更新今日文章和名言');

  // 重置所有文章的is_today标志
  db.run('UPDATE articles SET is_today = 0', (err) => {
    if (err) console.error('重置文章失败:', err);
  });

  // 重置所有名言的is_today标志
  db.run('UPDATE quotes SET is_today = 0', (err) => {
    if (err) console.error('重置名言失败:', err);
  });

  // 获取最新的一篇文章并设为今日文章
  db.get(
    'SELECT id FROM articles ORDER BY published_at DESC LIMIT 1',
    (err, article) => {
      if (!err && article) {
        db.run('UPDATE articles SET is_today = 1 WHERE id = ?', [article.id], (err) => {
          if (err) {
            console.error('设置今日文章失败:', err);
          } else {
            console.log('已设置今日文章:', article.id);
          }
        });
      }
    }
  );

  // 获取最新的一条名言并设为今日名言
  db.get(
    'SELECT id FROM quotes ORDER BY published_at DESC LIMIT 1',
    (err, quote) => {
      if (!err && quote) {
        db.run('UPDATE quotes SET is_today = 1 WHERE id = ?', [quote.id], (err) => {
          if (err) {
            console.error('设置今日名言失败:', err);
          } else {
            console.log('已设置今日名言:', quote.id);
          }
        });
      }
    }
  );
});
// ==================== 手动设置今日内容的接口（管理员）====================
// ... (app.post('/admin/article/set-today/:id', ...) 和 app.post('/admin/quote/set-today/:id', ...) 保持不变)
// 手动设置今日文章
app.post('/admin/article/set-today/:id', authenticateToken, verifyAdmin, (req, res) => {
  const { id } = req.params;

  // 先重置所有文章
  db.run('UPDATE articles SET is_today = 0', (err) => {
    if (err) {
      return res.status(500).json({ message: '重置文章失败' });
    }

    // 设置指定文章为今日文章
    db.run('UPDATE articles SET is_today = 1 WHERE id = ?', [id], function (err) {
      if (err) {
        return res.status(500).json({ message: '设置今日文章失败' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ message: '文章不存在' });
      }
      res.json({ message: '今日文章已更新' });
    });
  });
});

// 手动设置今日名言
app.post('/admin/quote/set-today/:id', authenticateToken, verifyAdmin, (req, res) => {
  const { id } = req.params;

  // 先重置所有名言
  db.run('UPDATE quotes SET is_today = 0', (err) => {
    if (err) {
      return res.status(500).json({ message: '重置名言失败' });
    }

    // 设置指定名言为今日名言
    db.run('UPDATE quotes SET is_today = 1 WHERE id = ?', [id], function (err) {
      if (err) {
        return res.status(500).json({ message: '设置今日名言失败' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ message: '名言不存在' });
      }
      res.json({ message: '今日名言已更新' });
    });
  });
});

// app.use(express.static(path.join(__dirname, '../daily_muse_app/build/web')));

// 处理 SPA 路由 - 所有未匹配的路由返回 index.html
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, './web/index.html'));
});

// ==================== 启动服务器 ====================
app.listen(8080, '0.0.0.0', () => {
  // console.log('🚀 后端已启动，监听地址: 0.0.0.0:3000');
  // console.log('📱 其他设备可通过以下地址访问:');
  // console.log('   http://localhost:3000');
  console.log('后端已启动，端口 8080');
  console.log('本机访问: http://localhost:8080');
  console.log('网络访问: http://<服务器IP>:8080');
  console.log('定时任务已启动，每天午夜00:00更新今日内容');
});
