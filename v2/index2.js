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

var toTagKey = function(tag) {
  tag = typeof tag === 'string' ? parse(tag) : tag
  return (tag.namespace || 'library')+'/'+tag.repository+':'+(tag.tag || 'latest')
}

var noop = function() {}

var Registry = function(opts) {
  if (!(this instanceof Registry)) return new Registry(opts)
  if (!opts) opts = {}

  var dir = opts.dir || '.'

  this.blobs = opts.blobs || blobs(path.join(dir, 'blobs'))
  this.db = sublevel(opts.db || level(path.join(dir, 'db')))
  this.db.images = this.db.sublevel('images')
  this.db.tags = this.db.sublevel('tags')
}

Registry.prototype.createLayerReadStream = function(id) {
  return this.blobs.createReadStream({key:id})
}

Registry.prototype.createIndexingStream = function() {
  var entry = function(entry, stream, cb) {
    stream.resume()

    var doc = {
      name: entry.name,
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      mtime: entry.mtime.getTime(),
      linkname: entry.linkname || undefined
    }

    console.log(doc)

    cb()
  }

  return pumpify(zlib.createGunzip(), tar.extract().on('entry', entry))
}

Registry.prototype.createLayerWriteStream = function(id, cb) {
  if (!cb) cb = noop

  var size = 0

  var track = function(data, enc, cb) {
    size += data.length
    cb(null, data)
  }

  var finish = function(err) {
    if (err) return cb(err)
    cb()
  }

  return pumpify(through(track), this.blobs.createWriteStream({key:id}, finish))
}

Registry.prototype.tree = function(id, cb) {

}

Registry.prototype.set = function(id, data, cb) {
  this.db.images.put(id, data, {valueEncoding:'json'}, cb)
}

Registry.prototype.get = function(id, cb) {
  this.db.images.get(id, {valueEncoding:'json'}, cb)
}

Registry.prototype.resolve = function(tag, cb) {
  var self = this
  this.db.tags.get(toTagKey(tag), {valueEncoding:'utf-8'}, function(err, id) {
    if (err && !err.notFound) return cb(err)
    self.get(id || tag, cb)
  })
}

Registry.prototype.finalize = function(id, checksum, cb) {

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
  if (tag && typeof tag === 'string') tag = parse(tag)
  if (!tag) tag = {}

  var prefix = ''

  if (tag.namespace || tag.repository) prefix += (tag.namespace || 'library')+'/'
  if (tag.repository) prefix += tag.repository+':'
  if (tag.tag) prefix += tag.tag

  return pump(
    this.db.tags.createReadStream({
      valueEncoding:'utf-8',
      start: prefix,
      end: prefix+'\xff'
    }),
    through.obj(function(data, enc, cb) {
      cb(null, {
        tag: data.key,
        id: data.value
      })
    })
  )
}

Registry.prototype.tag = function(tag, id, cb) {
  this.db.tags.put(toTagKey(tag), id, {valueEncoding:'utf-8'}, cb)
}

Registry.prototype.untag = function(tag, id, cb) {
  this.db.tags.del(toTagKey(tag), id, cb)
}

if (require.main !== module) return

var r = Registry()

r.createLayerReadStream('ff342f89cde22071b4eb13e4d5cdbe0ebfce6e8004249e8851b291b06d033079')
  .pipe(r.createIndexingStream())

// r.createTagStream('foo').on('data', console.log)

// //r.tag('foo:lol', 'ba66f09d1ae9718d1a6435aaf9f478df4167fadc88c83ff3afa0421970e0f180')
// //r.resolve('foo', console.log)
