#!/usr/bin/env node

var registry = require('./')
var minimist = require('minimist')

var argv = minimist(process.argv, {alias:{p:'port'}})
var server = registry()

var log = function(ns) {
  ns += '        '.slice(ns.length)+' :'
  console.log(Array.prototype.join.call(arguments, ' '))
}

var id = function(obj) {
  return obj.id.slice(0,12)
}

server.on('tag', function(image) {
  log('tag', id(image), image.name+'@'+image.tag)
})

server.on('layer', function(layer) {
  log('layer', id(layer), layer.path)
})

server.on('checksum', function(image) {
  log('checksum', id(image), image.hash)
})

server.on('image', function(image) {
  log('image', id(image), image.name)
})

server.listen(argv.port || 8000, function() {
  console.log('Server is listening on port '+server.address().port)
})