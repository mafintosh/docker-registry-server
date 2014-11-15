#!/usr/bin/env node

var registry = require('./server')
var minimist = require('minimist')
var peerca = require('peerca')
var fs = require('fs')
var proc = require('child_process')
var split = require('split2')

var argv = minimist(process.argv, {alias:{p:'port', c:'cert', u:'user'}})

if (argv.help) {
  console.log(fs.readFileSync(__dirname+'/help.txt', 'utf-8'))
  process.exit(0)
}

var users = [].concat(argv.user || [])
var authenticate = !users.length ? null : function(user, cb) {
  if (users.indexOf(user.name+':'+user.pass) === -1) return cb(new Error('Unknown user'))
  cb()
}

var server = registry({authenticate:authenticate})
var client = server.client

var noop = function() {}

var shorten = function(id) {
  return id.slice(0,12)
}

var hook = function(name, id, args) {
  var onchild = function(child) {
    console.log('%s - executing ./hooks/%s %s', shorten(id), name, args.join(' '))

    var ondata = function(data) {
      console.log('%s - ./hooks/%s: %s', shorten(id), name, data)
    }

    child.on('error', noop)
    child.stdout.pipe(split()).on('data', ondata)
    child.stderr.pipe(split()).on('data', ondata)
  }

  var on = argv['on-'+name]
  var file = './hooks/'+name

  if (on) return onchild(proc.spawn('/bin/bash', ['-c', on, name].concat(args)))

  fs.exists(file, function(exist) {
    if (exist) onchild(proc.spawn(file, args))
  })
}

client.on('tag', function(id, tag) {
  console.log('%s - tagged with %s', shorten(id), tag)
  hook('tag', id, [id, tag])
})

client.on('layer', function(id, metadata) {
  console.log('%s - added layer (%s)', shorten(id), metadata.checksum)
  hook('layer', id, [id])
})

client.on('image', function(id, data) {
  console.log('%s - added image data', shorten(id))
  hook('image', id, [id])
})

client.on('verify', function(id) {
  console.log('%s - verified using client checksum', shorten(id))
  hook('verify', id, [id])
})

client.on('index', function(id) {
  console.log('%s - indexed layer data', shorten(id))
  hook('index', id, [id])
})

var ssl = argv.cert && peerca({host:argv.cert}).options()

server.listen(argv.port || process.env.PORT || 8000, ssl, function() {
  if (ssl) console.log('Using peerca certificate for %s', argv.cert)
  console.log('Server is listening on port %d', server.address().port)
})
