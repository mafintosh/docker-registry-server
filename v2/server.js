var root = require('root')
var registry = require('./')()

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
  registry.images.get(req.params.id, function(err, image) {
    if (err) return res.error(err)
    res.send(image)
  })
})

server.put('/v1/images/{id}/json', function(req, res) {
  req.on('json', function(image) {
    registry.images.put(req.params.id, image, function(err) {
      if (err) return res.error(err)
      res.end()
    })
  })
})

server.put('/v1/images/{id}/layer', function(req, res) {
  var ws = registry.layers.write(req.params.id, function(err) {
    if (err) return cb(err)
    res.end()
  })

  req.pipe(ws)
})

server.put('/v1/images/{id}/checksum', function(req, res) {
  res.end()
})

server.put('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
  var repo = req.params.namespace+'/'+req.params.name

  req.on('json', function(id) {
    registry.tags.put(repo, req.params.tag, id, function(err) {
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

server.listen(8001)