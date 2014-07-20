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

module.exports = function(opts) {
  if (!opts) opts = {}

  var server = root()
  var cwd = opts.cwd || '.'
  var layers = path.join(cwd, 'layers')

  // setup db

  var db = sublevel(levelup(path.join(cwd, 'db'), {valueEncoding:'json', db: process.env.MEMDOWN ? memdown : leveldown}))

  db.images = db.sublevel('images')
  db.images.checksums = db.images.sublevel('checksums')

  db.repositories = db.sublevel('repositories')
  db.repositories.tags = db.repositories.sublevel('tags')

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

    db.images.checksums.get(id, function(err, checksum) {
      if (err) return res.error(err)
      res.setHeader('X-Docker-Checksum', checksum)
      db.images.get(id, function(err, data) {
        if (err) return res.error(err)
        res.send(data)
      })
    })
  })

  server.put('/v1/images/{id}/json', function(req, res) {
    var id = req.params.id

    req.on('json', function(data) {
      db.images.put(id, data, function(err) {
        if (err) return res.error(err)
        server.emit('image', id, data)
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
      server.emit('checksum', id, sum)
      res.end()
    })
  })

  server.put('/v1/images/{id}/layer', function(req, res) {
    var id = req.params.id

    mkdirp(layers, function(err) {
      if (err) return res.error(err)
      var layer = fs.createWriteStream(path.join(layers, id))
      pump(req, layer, function(err) {
        if (err) return res.error(err)
        server.emit('layer', id)
        res.end()
      })
    })
  })

  server.get('/v1/images/{id}/layer', function(req, res) {
    var id = req.params.id
    var layer = fs.createReadStream(path.join('layers', id))

    pump(layer, res)
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
    var tag = req.params.namespace+'/'+req.params.name+'@'+req.params.tag

    db.repositories.tags.get(tag, function(_, id) {
      db.repositories.tags.del(tag, function(err) {
        if (err) return res.error(err)
        if (id) server.emit('untag', id, tag)
        res.end()
      })
    })
  })

  server.put('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var tag = req.params.namespace+'/'+req.params.name+'@'+req.params.tag

    req.on('json', function(id) {
      db.repositories.tags.put(tag, id, function(err) {
        if (err) return res.error(err)
        server.emit('tag', id, tag)
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
    var tag = req.params.namespace+'/'+req.params.name+'/'+req.params.tag

    db.repositories.tags.get(tag, function(err, id) {
      if (err) return res.error(err)
      res.send(id)
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

  // misc stuff

  server.get('/v1/_ping', function(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.send('true')
  })

  server.error(function(req, res, err) {
    if (err && err.notFound) res.statusCode = 404
    res.send({
      status: res.statusCode,
      error: err.message
    })
  })

  return server
}