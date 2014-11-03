var blobs = require('fs-blob-store')
var level = require('level')
var sublevel = require('level-sublevel')
var path = require('path')
var mkdirp = require('mkdirp')
var events = require('events')
var through = require('through2')
var parse = require('docker-parse-image')
var from = require('from2')
var pump = require('pump')
var pumpify = require('pumpify')
var tar = require('tar-stream')
var zlib = require('zlib')
var union = require('sorted-union-stream')
var lexint = require('lexicographic-integer')
var eos = require('end-of-stream')
var crypto = require('crypto')
var events = require('events')
var util = require('util')

var IGNORE_TAR_FILES = ['./', '.wh..wh.aufs', '.wh..wh.orph/', '.wh..wh.plnk/']

var parseMaybe = function(tag) {
  return tag && typeof tag === 'object' ? tag : parse(tag)
}

var toSortKey = function(data) {
  return data.key.slice(64)
}

var toIndexKey = function(id, name) {
  var depth = name.split('/').length-1
  return id+'/'+lexint.pack(depth, 'hex')+name
}

var error = function(status, message) {
  var err = new Error(message)
  err.status = status
  return err
}

var peek = function(stream, cb) { // TODO: use module when not a plane
  var result = null

  stream.on('data', function(data) {
    result = data
  })

  eos(stream, function(err) {
    if (err) return cb(err)
    cb(null, result)
  })
}

var noop = function() {}

var Registry = function(opts) {
  if (!(this instanceof Registry)) return new Registry(opts)
  if (!opts) opts = {}

  events.EventEmitter.call(this)

  var dir = opts.dir || '.'

  this.blobs = opts.blobs || blobs(path.join(dir, 'layers'))
  this.db = sublevel(opts.db || level(path.join(dir, 'db')))
  this.db.images = this.db.sublevel('images')
  this.db.tags = this.db.sublevel('tags')
  this.db.index = this.db.sublevel('index')
  this.db.metadata = this.db.sublevel('metadata')
}

util.inherits(Registry, events.EventEmitter)

Registry.prototype.createLayerReadStream = function(id) {
  return this.blobs.createReadStream({key:id})
}

Registry.prototype.createIndexingStream = function(id) {
  var self = this
  var extract = tar.extract()
  var entries = 0
  var batch = []

  var flush = function(cb) {
    self.db.index.batch(batch, function(err) {
      batch = []
      cb(err)
    })
  }

  extract.on('entry', function(entry, stream, cb) {
    stream.resume()

    if (IGNORE_TAR_FILES.indexOf(entry.name) !== -1) return cb()
    if (!/^\//.test(entry.name)) entry.name = '/'+entry.name

    var doc = {
      path: entry.name,
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      mtime: entry.mtime.getTime(),
      image: id,
      linkname: entry.linkname || undefined
    }

    var path = doc.path
    if (path !== '/') path = path.replace(/\/$/, '')

    entries++
    batch.push({type:'put', key: toIndexKey(id, path), value: doc, valueEncoding: 'json'})

    if (entries % 64 === 0) flush(cb)
    else cb()
  })

  var stream = pumpify(zlib.createGunzip(), extract)

  stream.on('finish', function() {
    self.emit('index', id)
  })

  stream.on('prefinish', function() {
    stream.cork()
    batch.push({type:'put', key: id, value: {image:id, entries:entries}, valueEncoding: 'json'})
    flush(function(err) {
      if (err) return stream.destroy(err)
      stream.uncork()
    })
  })

  return stream
}

Registry.prototype.ensureIndex = function(id, cb) {
  var self = this
  this.db.index.get(id, function(err) {
    if (!err) return cb()
    pump(self.createLayerReadStream(id), self.createIndexingStream(id), cb)
  })
}

Registry.prototype.clearIndex = function(cb) {
  var self = this
  var del = through.obj(function(key, enc, cb) {
    self.db.index.del(key, cb)
  })

  pump(this.db.index.createKeyStream(), del, cb)
}

Registry.prototype.createLayerWriteStream = function(id, cb) {
  if (!cb) cb = noop

  var self = this
  var size = 0
  var first = true
  var sha = crypto.createHash('sha256')

  var indexFirst = function(data, enc, cb) {
    first = false
    self.db.images.get(id, {valueEncoding:'utf-8'}, function(err, val) {
      if (err) return cb(err)
      sha.update(val.replace(/>/g, '\\u003e').replace(/</g, '\\u003c').replace(/&/g, '\\u0026')+'\n') // hack for crazy docker json
      index(data, enc, cb)
    })
  }

  var index = function(data, enc, cb) {
    if (first) return indexFirst(data, enc, cb)
    size += data.length
    sha.update(data)
    cb(null, data)
  }

  var finish = function(err) {
    if (err) return cb(err)
    var metadata = {checksum: 'sha256:'+sha.digest('hex'), size: size}
    self.db.metadata.put(id, metadata, {valueEncoding:'json'}, function(err) {
      if (err) return cb(err)
      self.emit('layer', id, metadata)
      cb()
    })
  }

  return pumpify(through(index), this.blobs.createWriteStream({key:id}, finish))
}

Registry.prototype.createBlobStream = function(id, filename) {
  var name = filename.replace(/^\//, '')
  var destroyed = false
  var result = through()
  var self = this

  var resolve = function(cb) {
    var tree = self.createTreeStream(id, name)
    var result = null

    tree.on('data', function(data) {
      if (data.path.replace(/^\//, '') === name) result = data
    })

    eos(tree, function(err) {
      if (err) return cb(err)
      if (!result) return cb(error(404, 'Could not find blob '+filename+' from '+id))
      cb(null, result)
    })
  }

  result.on('close', function() {
    destroyed = true
  })

  resolve(function(err, resolved) {
    if (destroyed) return
    if (err) return result.destroy(err)

    var extract = tar.extract()
    var found = false

    result.on('close', function() {
      extract.destroy()
    })

    var entry = function(entry, stream, next) {
      if (entry.name.replace(/^\//, '') !== name) {
        stream.resume()
        return next()
      }

      found = true
      pump(stream, result, function() {
        extract.destroy()
      })
    }

    pump(self.createLayerReadStream(resolved.image), zlib.createGunzip(), extract.on('entry', entry), function() {
      if (!found) result.destroy(error(404, 'Could not find '+filename))
    })
  })

  return result
}

Registry.prototype.createTreeStream = function(id, prefix) {
  if (!prefix) prefix = '/'
  if (prefix[0] !== '/') prefix = '/'+prefix

  var self = this
  var ids = [] // bounded ~128 entries so it is ok to buffer
  var destroyed = false
  var ancestry = this.createAncestorStream(id)
  var result = through.obj(function(data, enc, cb) {
    cb(null, JSON.parse(data.value))
  })

  var index = through.obj(function(data, enc, cb) {
    ids.unshift(data.id)
    self.ensureIndex(data.id, cb)
  })

  result.on('close', function() {
    destroyed = true
  })

  pump(ancestry, index, function(err) {
    if (err || destroyed) return result.destroy(err)
    if (!ids.length) return result.destroy(error(404, 'Could not find image '+id))

    var stream = ids
      .map(function(id) {
        var key = toIndexKey(id, prefix)
        return self.db.index.createReadStream({
          gte: key,
          lt: key+'\xff'
        })
      })
      .reduce(function(a, b) {
        return union(a, b, toSortKey)
      })

    pump(stream, result)
  })

  return result
}

Registry.prototype.set = function(id, data, cb) {
  if (!cb) cb = noop
  var self = this
  this.db.images.put(id, data, {valueEncoding:'json'}, function(err) {
    if (err) return cb(err)
    self.emit('image', id, data)
    cb()
  })
}

Registry.prototype.get = function(id, cb) {
  var self = this
  this.db.images.get(id, {valueEncoding:'json'}, function(err, image) {
    if (err) return cb(err)
    self.db.metadata.get(id, {valueEncoding:'json'}, function(err, metadata) {
      if (err) return cb(err)
      cb(null, image, metadata)
    })
  })
}

Registry.prototype.resolve = function(tag, cb) {
  var self = this
  var fullname = parseMaybe(tag).fullname

  this.db.tags.get(fullname, {valueEncoding:'utf-8'}, function(err, id) {
    if (err && !err.notFound) return cb(err)
    if (id) return self.get(id, cb)
    if (tag.length !== 12) return cb(err)

    var stream = self.db.images.createKeyStream({
      gte: tag,
      limit: 1
    })

    peek(stream, function(err, key) {
      if (err) return cb(err)
      if (!key || key.indexOf(tag) !== 0) return self.get(tag, cb)
      self.get(key, cb)
    })
  })
}

Registry.prototype.verify = function(id, checksum, cb) {
  if (!cb) cb = noop

  var self = this
  this.db.metadata.get(id, {valueEncoding:'json'}, function(err, metadata) {
    if (err) return cb(err)
    if (metadata.checksum === checksum) {
      self.emit('verify', id)
      return cb(null, true)
    }

    self.db.images.del(id, function() {
      self.db.metadata.del(id, function() {
        cb(null, false) // TODO: unlink layer as well when remove lands in blob store
     })
    })
  })
}

Registry.prototype.createAncestorStream = function(id) {
  var imgs = this.db.images
  return from.obj(function(size, cb) {
    if (!id) return cb(null, null)
    imgs.get(id, {valueEncoding:'json'}, function(err, result) {
      if (err) return cb(err)
      id = result.parent
      cb(null, result)
    })
  })
}

Registry.prototype.createImageStream = function() {
  return this.db.images.createValueStream({valueEncoding:'json'})
}

Registry.prototype.createTagStream = function(tag) {
  tag = parseMaybe(tag || {})

  var prefix = ''

  if (tag.namespace || tag.repository) prefix += (tag.namespace || 'library')+'/'
  if (tag.repository) prefix += tag.repository+':'
  if (tag.tag) prefix += tag.tag

  return pump(
    this.db.tags.createReadStream({
      valueEncoding:'utf-8',
      gte: prefix,
      lt: prefix+'\xff'
    }),
    through.obj(function(data, enc, cb) {
      var parsed = parse(data.key)
      parsed.id = data.value
      cb(null, parsed)
    })
  )
}

Registry.prototype.tag = function(id, tag, cb) {
  if (!cb) cb = noop

  var self = this
  tag = parseMaybe(tag)

  this.db.tags.put(tag.fullname, id, {valueEncoding:'utf-8'}, function(err) {
    if (err) return cb(err)
    self.emit('tag', id, tag.name)
    cb()
  })
}

Registry.prototype.untag = function(id, tag, cb) {
  if (!cb) cb = noop

  var self = this
  tag = parseMaybe(tag)

  this.db.tags.del(tag.fullname, id, function(err) {
    if (err) return cb(err)
    self.emit('untag', id, tag.name)
    cb()
  })
}

module.exports = Registry
