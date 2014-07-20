#!/usr/bin/env node

var registry = require('./')
var server = registry()

var log = function(ns) {
  ns += '     '.slice(ns.length)+' :'
  console.log(Array.prototype.join.call(arguments, ' '))
}

server.on('tag', function(id, tag) {
  log('tag', id, tag)
})

server.on('layer', function(id) {
  log('layer', id)
})

server.on('checksum', function(id, checksum) {
  log('sum', id, checksum)
})

server.on('image', function(id, data) {
  log('image', id)
})

server.listen(8000)