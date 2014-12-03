var root = require('root')
var JSONStream = require('JSONStream')
var ndjson = require('ndjson')
var through = require('through2')
var pump = require('pump')
var cors = require('cors')
var cookie = require('cookie-signature')
var crypto = require('crypto')
var collect = require('stream-collector')
var auth = require('basic-auth')
var relative = require('relative-date')
var registry = require('./registry')

var authenticateAll = function(creds, cb) {
  cb(null, 'anon')
}

module.exports = function(opts) {
  if (!opts) opts = {}

  var secret = (opts.secret || crypto.randomBytes(64)).toString()
  var authenticate = opts.authenticate || authenticateAll
  var client = registry(opts)
  var server = root()
  var started = new Date()

  // auth stuff

  var now = function() {
    return (Date.now() / 1000) | 0
  }

  var login = function(req, res) {
    res.statusCode = 401
    res.setHeader('WWW-Authenticate', 'Token')
    res.send({error: 'Requires authorization'})      
  }

  var token = function(req, res) {
    var auth = req.headers.authorization
    if (!auth || auth.slice(0, 6) !== 'Token ') return null

    var token = cookie.unsign(auth.slice(6), secret)
    if (!token) return null

    var i = token.lastIndexOf('.')
    if (i === -1) return null

    if (!(Number(token.slice(i+1)) > now())) return null
    return token.slice(0, i)
  }

  // library paths

  server.client = client
  server.setMaxListeners(0)

  client.on('tag', function(id, tag) {
    server.emit('event', {type:'tag', id:id, tag:tag})
  })

  client.on('untag', function(id, tag) {
    server.emit('event', {type:'untag', id:id, tag:tag})
  })

  client.on('image', function(id, data) {
    server.emit('event', {type:'image', id:id})
  })

  client.on('layer', function(id, metadata) {
    server.emit('event', {type:'layer', id:id, checksum:metadata.checksum})
  })

  client.on('verify', function(id) {
    server.emit('event', {type:'verify', id:id})
  })

  server.all(cors())

  server.get('/v1/_ping', function(req, res) {
    res.setHeader('Content-Length', 4)
    res.end('true')
  })

  server.get('/', function(req, res) {
    res.send({
      name: 'docker-registry-server',
      version: require('./package.json').version,
      status: 'Started '+relative(started)
    })
  })

  server.all(function(req, res, next) {
    req.username = token(req)
    if (req.username !== null) {
      if (req.username) server.emit('verify', req.username)
      return next()
    }

    var creds = auth(req)
    if (creds || authenticate === authenticateAll) {
      authenticate(creds, function(err, name) {
        if (err) return login(req, res)
        req.username = name || creds.name || ''
        var token = cookie.sign(req.username+'.'+(now()+6*3600), secret)
        res.setHeader('WWW-Authenticate', 'Token '+token)
        res.setHeader('X-Docker-Token', token)
        res.setHeader('X-Docker-Endpoints', req.headers.host)
        if (req.username) server.emit('login', req.username)
        next()
      })
      return
    }

    login(req, res)
  })

  server.all('/v1/repositories/{name}', '/v1/repositories/library/{name}')
  server.all('/v1/repositories/{name}/images', '/v1/repositories/library/{name}/images')
  server.all('/v1/repositories/{name}/tags/*', '/v1/repositories/library/{name}/tags/{*}')

  server.get('/v1/users', function(req, res) {
    res.send({
      username: req.username
    })
  })

  server.get('/v1/events', function(req, res) {
    var stringify = ndjson.stringify()
    var type = [].concat(req.query.type || [])
    var onevent = function(e) {
      if (!type.length || type.indexOf(e.type) > -1) stringify.write(e)
    }

    server.on('event', onevent)
    req.setTimeout(0)
    pump(stringify, res, function() {
      server.removeListener('event', onevent)
    })
  })

  server.put('/v1/repositories/{namespace}/{name}', function(req, res) {
    req.on('json', function() {
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
    req.on('body', function(image) { // use raw body to ensure JSON hash check works
      client.set(req.params.id, image, function(err) {
        if (err) return res.error(err)
        res.end()
      })
    })
  })

  server.get('/v1/images/{id}/layer', function(req, res) {
    pump(client.createLayerReadStream(req.params.id), res)
  })

  server.put('/v1/images/{id}/layer', function(req, res) {
    var ws = client.createLayerWriteStream(req.params.id, function(err) {
      if (err) return res.error(err)
      res.end()
    })

    pump(req, ws)
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

  server.del('/v1/repositories/{namespace}/{name}/tags/{tag}', function(req, res) {
    var tag = req.params.namespace+'/'+req.params.name+':'+req.params.tag

    collect(client.createTagStream(tag), function(err, tags) {
      if (err) return res.error(err)
      if (!tags.length) return res.send("")

      client.untag(tags[0].id, tag, function(err) {
        if (err) return res.error(error)
        res.send("")
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
