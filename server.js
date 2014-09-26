var root = require('root')
var JSONStream = require('JSONStream')
var through = require('through2')
var pump = require('pump')
var cors = require('cors')
var registry = require('./')

module.exports = function() {
  var client = registry()
  var server = root()

  // library paths

  server.client = client
  server.setMaxListeners(0)

  client.on('tag', function(id, tag) {
    server.emit('event', {type:'tag', image:id, tag:tag})
  })

  client.on('untag', function(id, tag) {
    server.emit('event', {type:'untag', image:id, tag:tag})
  })

  server.all(cors())

  server.all('/v1/repositories/{name}', '/v1/repositories/library/{name}')
  server.all('/v1/repositories/{name}/images', '/v1/repositories/library/{name}/images')
  server.all('/v1/repositories/{name}/tags/*', '/v1/repositories/library/{name}/tags/{*}')

  server.get('/v1/_ping', function(req, res) {
    res.setHeader('Content-Length', 4)
    res.end('true')
  })

  server.get('/v1/events', function(req, res) {
    var stringify = JSONStream.stringify()
    var onevent = function(e) {
      stringify.write(e)
    }

    server.on('event', onevent)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    req.setTimeout(0)
    pump(stringify, res, function() {
      server.removeListener('event', onevent)
    })
  })

  server.put('/v1/repositories/{namespace}/{name}', function(req, res) {
    req.on('json', function() {
      res.setHeader('WWW-Authenticate', 'Token signature=123abc,repository="test",access=write')
      res.setHeader('X-Docker-Token', 'signature=123abc,repository="test",access=write')
      res.setHeader('X-Docker-Endpoints', req.headers.host)
      res.end()
    })
  })

  server.get('/v1/images/{id}/json', function(req, res) {
    client.get(req.params.id, function(err, image, metadata) {
      if (err) return res.error(err)
      res.setHeader('X-Docker-Size', metadata.size)
      res.setHeader('X-Docker-Checksum', metadata.checksum)
      res.send(image)
    })
  })

  server.put('/v1/images/{id}/json', function(req, res) {
    req.on('json', function(image) {
      client.set(req.params.id, image, function(err) {
        if (err) return res.error(err)
        res.end()
      })
    })
  })

  server.put('/v1/images/{id}/layer', function(req, res) {
    var ws = client.createLayerWriteStream(req.params.id, function(err) {
      if (err) return cb(err)
      res.end()
    })

    req.pipe(ws)
  })

  server.get('/v1/images/{id}/ancestry', function(req, res) {
    pump(
      client.createAncestorStream(req.params.id),
      through.obj(function(data, enc, cb) {
        cb(null, data.id)
      }),
      JSONStream.stringify(),
      res
    )
  })

  server.get('/v1/images/{id}/blobs/*', function(req, res) {
    pump(
      client.createBlobStream(req.params.id, req.params.glob),
      res
    )
  })

  server.get('/v1/images/{id}/tree/*', function(req, res) {
    var dir = req.params.glob
    if (!/\/$/.test(dir)) dir += '/'

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    pump(
      client.createTreeStream(req.params.id, dir),
      through.obj(function(data, enc, cb) {
        if (data.type === 'directory') data.cd = 'http://'+req.headers.host+'/v1/images/'+req.params.id+'/tree'+data.name
        else data.blob = 'http://'+req.headers.host+'/v1/images/'+data.image+'/blobs'+data.name
        cb(null, data)
      }),
      JSONStream.stringify(),
      res
    )
  })

  server.put('/v1/images/{id}/checksum', function(req, res) {
    client.verify(req.params.id, req.headers['x-docker-checksum-payload'] || null, function(err, verified) {
      if (err) return res.error(err)
      if (!verified) return res.error(400, 'checksum mismatch') // TODO: is 400 the correct thing to send here?
      res.end()
    })
  })

  server.get('/v1/repositories/{namespace}/{name}/tags', function(req, res) {
    var tags = client.createTagStream(req.params.namespace+'/'+req.params.name)

    pump(
      tags,
      through.obj(function(data, enc, cb) {
        cb(null, [data.tag, data.id])
      }),
      JSONStream.stringifyObject(),
      res
    )
  })

  server.get('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var tag = req.params.namespace+'/'+req.params.name+':'+req.params.tag

    client.resolve(tag, function(err, image) {
      if (err) return res.error(err)
      res.end(image.id)
    })
  })

  server.put('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var tag = req.params.namespace+'/'+req.params.name+':'+req.params.tag

    req.on('json', function(id) {
      client.tag(id, tag, function(err) {
        if (err) return res.error(err)
        res.end()
      })
    })
  })

  server.get('/v1/repositories/{namespace}/{name}/images', function(req, res) { // wat?
    res.send([])
  })

  server.put('/v1/repositories/{namespace}/{name}/images', function(req, res) { // wat?
    req.on('json', function(data) {
      res.statusCode = 204
      res.end()
    })
  })

  server.get('/v1/repositories', function(req, res) {
    pump(
      client.createTagStream(),
      through.obj(function(data, enc, cb) {
        cb(null, [data.name, data.id])
      }),
      JSONStream.stringifyObject(),
      res
    )
  })

  server.get('/', function(req, res) {
    res.send({
      name: 'docker-registry-server',
      version: require('./package.json').version
    })
  })

  server.error(function(req, res, err) {
    if (err.status) res.statusCode = err.status
    if (res.statusCode !== 404) console.error('Error: %s (%d)', err.message, res.statusCode)
    res.send({
      error: err.message,
      status: err.status
    })
  })

  return server
}
