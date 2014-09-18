var blobs = require('fs-blob-store')
var level = require('level')
var sublevel = require('level-sublevel')
var path = require('path')
var mkdirp = require('mkdirp')
var events = require('events')
var through = require('through2')
var pump = require('pump')

var create = function(opts) {
  if (!opts) opts = {}

  var dir = opts.dir || '.'
  var store = opts.blobs || blobs(path.join(dir, 'blobs'))
  var db = opts.db || sublevel(level(path.join(dir, 'db')))

  var that = new events.EventEmitter()

  db.images = db.sublevel('images')
  db.tags = db.sublevel('tags')

  // should use another level maybe?
  var cache = db.sublevel('cache')

  // layers

  that.layers = {}

  that.layers.read = function(id) {
    return store.createReadStream({key:id})
  }

  that.layers.write = function(id, cb) {
    return store.createWriteStream({key:id}, cb)
  }

  that.tree = {}

  that.tree.get = function(id, dir, cb) {
    cache.get('indexed/'+id, function(err) {

    })
  }

  // images

  that.images = {}

  that.images.put = function(id, data, cb) {
    db.images.put('images/'+id, data, {valueEncoding:'json'}, cb)
  }

  that.images.get = function(id, cb) {
    db.images.get('images/'+id, {valueEncoding:'json'}, cb)
  }

  that.images.list = function() {
    return db.images.createValueStream({valueEncoding:'json'})
  }

  that.checksums = {}

  that.checksums.put = function(id, sum, cb) {

  }

  // tags

  that.tags = {}

  that.tags.put = function(repo, tag, id, cb) {
    db.tags.put(repo+'@'+tag, id, {valueEncoding:'utf-8'}, cb)
  }

  that.tags.get = function(repo, tag, cb) {
    db.tags.get(repo+'@'+tag, {valueEncoding:'utf-8'}, cb)
  }

  that.tags.list = function(repo) {
    var rs = db.tags.createReadStream({
      start: repo+'@',
      end: repo+'@~',
      valueEncoding: 'utf-8'
    })

    var format = through.obj(function(data, enc, cb) {
      cb(null, {
        repo: repo,
        tag: data.key.split('@').pop(),
        id: data.value
      })
    })

    return pump(rs, format)
  }

  return that
}

module.exports = create

if (require.main !== module) return

var registry = create()

registry.images.put('hello', {hej:'world'}, function() {
  registry.images.list().on('data', console.log)
})