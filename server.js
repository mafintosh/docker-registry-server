var root = require('root')
var JSONStream = require('JSONStream')
var through = require('through2')
var pump = require('pump')
var registry = require('./')

module.exports = function() {
  var docker = registry()
  var server = root()

  // library paths

  server.all('/v1/repositories/{name}', '/v1/repositories/library/{name}')
  server.all('/v1/repositories/{name}/images', '/v1/repositories/library/{name}/images')
  server.all('/v1/repositories/{name}/tags/*', '/v1/repositories/library/{name}/tags/{*}')

  server.get('/v1/_ping', function(req, res) {
    res.setHeader('Content-Length', 4)
    res.end('true')
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
    docker.get(req.params.id, function(err, image) {
      if (err) return res.error(err)
      res.send(image)
    })
  })

  server.put('/v1/images/{id}/json', function(req, res) {
    req.on('json', function(image) {
      docker.set(req.params.id, image, function(err) {
        if (err) return res.error(err)
        res.end()
      })
    })
  })

  server.put('/v1/images/{id}/layer', function(req, res) {
    var ws = docker.createLayerWriteStream(req.params.id, function(err) {
      if (err) return cb(err)
      res.end()
    })

    req.pipe(ws)
  })

  server.get('/v1/images/{id}/blobs/*', function(req, res) {
    pump(
      docker.createBlobStream(req.params.id, req.params.glob),
      res
    )
  })

  server.get('/v1/images/{id}/tree/*', function(req, res) {
    var dir = req.params.glob
    if (!/\/$/.test(dir)) dir += '/'

    pump(
      docker.createTreeStream(req.params.id, dir),
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
    res.end()
  })

  server.put('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var tag = req.params.namespace+'/'+req.params.name+':'+req.params.tag

    req.on('json', function(id) {
      docker.tag(tag, id, function(err) {
        if (err) return res.error(err)
        res.end()
      })
    })
  })

  server.put('/v1/repositories/{namespace}/{name}/images', function(req, res) {
    req.on('json', function(data) {
      res.statusCode = 204
      res.end()
    })
  })

  server.all(function(req, res) {
    console.log(req.method, req.url)
  })

  return server
}
