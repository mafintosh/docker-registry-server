#!/usr/bin/env node

var registry = require('./server')
var minimist = require('minimist')

var argv = minimist(process.argv, {alias:{p:'port'}})
var server = registry()
var client = server.client

var shorten = function(id) {
  return id.slice(0,12)
}

client.on('tag', function(id, tag) {
  console.log('%s - tagged with %s', shorten(id), tag)
})

client.on('layer', function(id, metadata) {
  console.log('%s - added layer (%s)', shorten(id), metadata.checksum)
})

client.on('image', function(id, data) {
  console.log('%s - added image data', shorten(id))
})

client.on('verify', function(id) {
  console.log('%s - verified using client checksum', shorten(id))
})

client.on('index', function(id) {
  console.log('%s - indexed layer data', shorten(id))
})

server.listen(argv.port || process.env.PORT || 8000, function() {
  console.log('Server is listening on port '+server.address().port)
})
