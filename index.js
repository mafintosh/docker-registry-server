var root = require('root')
var from = require('from2')
var fs = require('fs')
var mkdirp = require('mkdirp')
var path = require('path')
var pump = require('pump')
var JSONStream = require('JSONStream')
var through = require('through2')
var levelup = require('levelup')
var leveldown = require('leveldown')
var sublevel = require('level-sublevel')
var memdown = require('memdown')
var thunky = require('thunky')
var tar = require('tar-stream')
var xtend = require('xtend')
var zlib = require('zlib')

module.exports = function(opts) {
  if (!opts) opts = {}

  var server = root()
  var cwd = opts.cwd || 'docker-registry'
  var layers = path.join(cwd, 'layers')
  var db

  // setup db

  var setup = thunky(function(cb) {
    mkdirp(layers, function() {
      db = sublevel(levelup(path.join(cwd, 'db'), {valueEncoding:'json', db: process.env.MEMDOWN ? memdown : leveldown}))

      db.images = db.sublevel('images')
      db.images.checksums = db.images.sublevel('checksums')
      db.images.blobs = db.sublevel('blobs')

      db.repositories = db.sublevel('repositories')
      db.repositories.tags = db.repositories.sublevel('tags')


      server.emit('setup')
      cb()
    })
  })

  server.all(function(req, res, next) {
    setup(next)
  })

  // library paths

  server.all('/v1/repositories/{name}', '/v1/repositories/library/{name}')
  server.all('/v1/repositories/{name}/images', '/v1/repositories/library/{name}/images')
  server.all('/v1/repositories/{name}/tags/*', '/v1/repositories/library/{name}/tags/{*}')

  // images

  var ancestry = function(parent) {
    return from.obj(function(size, next) {
      if (!parent) return next(null, null)
      db.images.get(parent, function(err, data) {
        if (err) return next(err)
        parent = data.parent
        next(null, data.id || null)
      })
    })
  }

  var emit = function(type, data) {
    server.emit(type, data)
    server.emit('event', xtend({type:type}, data))
  }

  server.setMaxListeners(0)

  // non official events api
  server.get('/v1/events', function(req, res) {
    res.setTimeout(0) // not perfect but lets just rely on this for now

    var onevent = function(e) {
      if (e.type === 'image') e = {type:'image', id:e.id, parent:e.parent} // dont send too much data
      res.write(JSON.stringify(e)+'\n')
    }

    res.on('close', function() {
      server.removeListener('event', onevent)
    })

    server.on('event', onevent)
  })

  // non official file api
  server.get('/v1/images/{id}/blob/*', function(req, res) {
    var id = req.params.id
    var filename = req.params.glob

    var search = function(id) {
      var layer = fs.createReadStream(path.join(layers, id))
      var extract = tar.extract()
      var found = false

      var ondone = function() {
        if (found) return
        db.images.get(id, function(err, img) {
          if (err) return res.error(err)
          if (!img.parent) return res.error(404, filename+' not found')
          search(img.parent)
        })
      }

      extract.on('entry', function(header, stream, next) {
        if (header.type !== 'file' || header.name !== filename) {
          stream.resume()
          return next()
        }

        found = true
        pump(stream, res, function() {
          extract.destroy()
        })
      })

      pump(layer, zlib.createGunzip(), extract, ondone)
    }

    search(id)
  })

  server.get('/v1/images/{id}/ancestry', function(req, res) {
    var id = req.params.id

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    pump(
      ancestry(id),
      JSONStream.stringify(),
      res
    )
  })

  server.get('/v1/images/{id}/json', function(req, res) {
    var id = req.params.id
    var file = path.join(layers, id)

    db.images.checksums.get(id, function(err, checksum) {
      if (err) return res.error(err)
      res.setHeader('X-Docker-Checksum', checksum)
      fs.stat(file, function(_, stat) {
        if (stat) res.setHeader('X-Docker-Size', stat.size)
        db.images.get(id, function(err, data) {
          if (err) return res.error(err)
          res.send(data)
        })
      })
    })
  })

  server.put('/v1/images/{id}/json', function(req, res) {
    var id = req.params.id

    req.on('json', function(data) {
      db.images.put(id, data, function(err) {
        if (err) return res.error(err)
        emit('image', data)
        res.end()
      })
    })
  })

  server.put('/v1/images/{id}/checksum', function(req, res) {
    var id = req.params.id
    var sum = req.headers['x-docker-checksum-payload'] || null

    if (!sum) return res.error(400, 'checksum is required')
    db.images.checksums.put(id, sum, function(err) {
      if (err) return res.error(err)
      emit('checksum', {id:id, hash:sum})
      res.end()
    })
  })

  server.put('/v1/images/{id}/layer', function(req, res) {
    var id = req.params.id
    var file = path.join(layers, id)
    var layer = fs.createWriteStream(file)

    pump(req, layer, function(err) {
      if (err) return res.error(err)
      emit('layer', {id:id, path:file})
      res.end()
    })
  })

  server.get('/v1/images/{id}/layer', function(req, res) {
    var id = req.params.id
    var file = path.join(layers, id)

    fs.stat(file, function(err, stat) {
      if (err) return res.error(404)
      res.setHeader('Content-Length', stat.size)
      pump(fs.createReadStream(file), res)
    })
  })

  // repo stuff

  server.put('/v1/repositories/{namespace}/{name}', function(req, res) {
    req.on('json', function(data) {
      res.setHeader('WWW-Authenticate', 'Token signature=123abc,repository="test",access=write')
      res.setHeader('X-Docker-Token', 'signature=123abc,repository="test",access=write')
      res.setHeader('X-Docker-Endpoints', req.headers.host)
      res.end()
    })
  })

  server.del('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var namespace = req.params.namespace
    var name = req.params.name
    var tag = req.params.tag
    var key = namespace+'/'+name+'@'+tag

    db.repositories.tags.get(key, function(_, id) {
      db.repositories.tags.del(key, function(err) {
        if (err) return res.error(err)
        if (id) emit('untag', {id:id, namespace:namespace, name:name, tag:tag})
        res.end()
      })
    })
  })

  server.put('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var namespace = req.params.namespace
    var name = req.params.name
    var tag = req.params.tag
    var key = namespace+'/'+name+'@'+tag

    req.on('json', function(id) {
      db.repositories.tags.put(key, id, function(err) {
        if (err) return res.error(err)
        emit('tag', {id:id, namespace:namespace, name:name, tag:tag})
        res.end()
      })
    })
  })

  server.get('/v1/repositories/{namespace}/{name}/tags', function(req, res) {
    var id = req.params.namespace+'/'+req.params.name

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    pump(
      db.repositories.tags.createReadStream({start:id+'@', end:id+'@~'}),
      through.obj(function(data, enc, cb) {
        cb(null, [data.key.split('@').pop(), data.value])
      }),
      JSONStream.stringifyObject(),
      res
    )
  })

  server.get('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var tag = req.params.namespace+'/'+req.params.name+'@'+req.params.tag

    db.repositories.tags.get(tag, function(err, id) {
      if (err) return res.error(err)
      res.setHeader('Content-Length', Buffer.byteLength(id))
      res.end(id)
    })
  })

  server.put('/v1/repositories/{namespace}/{name}/images', function(req, res) {
    var id = req.params.namespace+'/'+req.params.name

    req.on('json', function(list) {
      db.images.put(id, list, function(err) {
        if (err) return res.error(err)
        res.statusCode = 204
        res.end()
      })
    })
  })

  server.get('/v1/repositories/{namespace}/{name}/images', function(req, res) {
    var id = req.params.namespace+'/'+req.params.name

    db.images.get(id, function(err, list) {
      if (err) return res.error(err)
      res.send(list)
    })
  })

  server.get('/', function(req, res) {
    res.send({
      service: 'docker-registry',
      version: require('./package').version
    })
  })

  // misc stuff

  server.get('/v1/_ping', function(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.send('true')
  })

  server.error(function(req, res, err) {
    res.send({
      status: res.statusCode,
      error: err.message.trim()
    })
  })

  return server
}