const {
  Repository
} = require('nodegit');

const logger = require('heimdalljs-logger');
const crypto = require('crypto');
const git = require('./git');
const os = require('os');
const process = require('process');
const Error = require('./error');

module.exports = class Writer {
  constructor({ repoPath, idGenerator }) {
    this.repoPath = repoPath;
    this.repo = null;
    this.log = logger('writer');
    let hostname = os.hostname();
    this.myName = `PID${process.pid} on ${hostname}`;
    this.myEmail = `${os.userInfo().username}@${hostname}`;
    this.idGenerator = idGenerator;
  }

  async create(branch, user, type, document) {
    this._requireType(type, document);
    return this._withErrorHandling(document.id, type, async () => {
      while (true) {
        try {
          // 20 bytes is good enough for git, so it's good enough for
          // me. In practice we probably have a lower collision
          // probability too, because we're allowed to retry if we know
          // the id is already in use (so we can really only collide
          // with things that have not yet merged into our branch).
          let id;
          if (document.id == null) {
            id = this._generateId();
          } else {
            id = document.id;
          }
          let doc = await this._create(branch, user, document, id);
          return doc;
        } catch(err) {
          if (err instanceof git.OverwriteRejected && document.id == null) {
            // ignore so our loop can retry
          } else {
            throw err;
          }
        }
      }
    });
  }

  async update(branch, user, type, id, document) {
    this._requireType(type, document);
    this._requireId(document);
    this._requireVersion(document);
    await this._ensureRepo();
    return this._withErrorHandling(id, type, async () => {
      let commitId = await git.mergeCommit(this.repo, document.meta.version, branch, [
        {
          operation: 'update',
          filename: `contents/${document.type}/${document.id}.json`,
          buffer: Buffer.from(JSON.stringify(document.attributes), 'utf8')
        }
      ], this._commitOptions('update', document.type, document.id, user));
      return {
        id: document.id,
        type: document.type,
        attributes: document.attributes,
        meta: {
          version: commitId
        }
      };
    });
  }

  async delete(branch, user, version, type, id) {
    await this._ensureRepo();
    return this._withErrorHandling(id, type, async () => {
      await git.mergeCommit(this.repo, version, branch, [
        {
          operation: 'delete',
          filename: `contents/${type}/${id}.json`
        }
      ], this._commitOptions('delete', type, id, user));
    });
  }

  async _create(branch, user, document, id) {
    await this._ensureRepo();
    let commitId = await git.mergeCommit(this.repo, null, branch, [
      {
        operation: 'create',
        filename: `contents/${document.type}/${id}.json`,
        buffer: Buffer.from(JSON.stringify(document.attributes), 'utf8')
      }
    ], this._commitOptions('create', document.type, id, user));

    return {
      id,
      type: document.type,
      attributes: document.attributes,
      meta: {
        version: commitId
      }
    };
  }

  async _withErrorHandling(id, type, fn) {
    try {
      return await fn();
    } catch (err) {
      if (/Unable to parse OID/.test(err.message) || /Object not found/.test(err.message)) {
        throw new Error(err.message, { status: 400, source: { pointer: '/data/meta/version' }});
      }
      if (err instanceof git.GitConflict) {
        throw new Error("Merge conflict", { status: 409 });
      }
      if (err instanceof git.OverwriteRejected) {
        throw new Error(`id ${id} is already in use`, { status: 409, source: { pointer: '/data/id'}});
      }
      if (err instanceof git.NotFound) {
        throw new Error(`${type} with id ${id} does not exist`, {
          status: 404,
          source: { pointer: '/data/id' }
        });
      }
      throw err;
    }
  }

  _requireVersion(document) {
    if (!document.meta || !document.meta.version) {
      throw new Error('missing required field', {
        status: 400,
        source: { pointer: '/data/meta/version' }
      });
    }
  }

  _requireId(document) {
    if (document.id == null) {
      throw new Error('missing required field', {
        status: 400,
        source: { pointer: '/data/id' }
      });
    }
  }

  _requireType(type, document) {
    if (document.type == null) {
      throw new Error('missing required field', {
        status: 400,
        source: { pointer: '/data/type' }
      });
    }
    if (document.type !== type) {
      throw new Error(`the type "${document.type}" is not allowed here`, {
        status: 409,
        source: { pointer: '/data/type' }
      });
    }
  }

  _commitOptions(operation, type, id, user) {
    return {
      authorName: user.fullName,
      authorEmail: user.email,
      committerName: this.myName,
      committerEmail: this.myEmail,
      message: `${operation} ${type} ${id.slice(12)}`
    };
  }

  async _ensureRepo() {
    if (!this.repo) {
      this.repo = await Repository.open(this.repoPath);
    }
  }

  _generateId() {
    if (this.idGenerator) {
      return this.idGenerator();
    } else {
      return crypto.randomBytes(20).toString('hex');
    }
  }

};