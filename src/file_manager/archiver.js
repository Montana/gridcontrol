'use strict';
const debug    = require('debug')('gc:archiver');
const raf      = require('random-access-file')
const bluebird = require('bluebird')
const fs       = bluebird.promisifyAll(require('fs'))
const p        = require('path')

module.exports = Archiver

function Archiver(options) {
  if(!(this instanceof Archiver)) { return new Archiver(options) }

  if(!options.drive) throw new ReferenceError('Provide a hyperdrive')
  if(!options.root) throw new ReferenceError('Provide a root directory')
  if(!options.interplanetary) throw new ReferenceError('Provide Interplanetary')

  this.drive = options.drive
  this.root = options.root
  this.interplanetary = options.interplanetary
};

/**
 * @param root root path
 * @param options.filters filters
 * @param options.maxDepth mas depth, default Infinity
 * @private
 * @return Promise
 */
Archiver.prototype._recursiveReaddir = function(root, options) {
  let items =  fs.readdirAsync(root)
  if (!options.root) options.root = root

  for (let i in options.filters)
    items = items.filter(options.filters[i])

  return items.map((f) => {
    var path = p.join(root, f)

    return fs.statAsync(path)
    .then((stat) => {
      let depth = root.replace(options.root, '').split(p.sep).length

      if (depth > options.maxDepth) {
        console.error('MaxDepth (%s) reached on %s recursive readDir', options.maxDepth, options.root)
        return options.onFile ? options.onFile(path, stat) : Promise.resolve(path)
      }

      if (stat.isDirectory()) {
        return this._recursiveReaddir(path, options)
      }

      return options.onFile ? options.onFile(path, stat) : Promise.resolve(path)
    })
  }).then(function(paths) {
    paths.push(root)
    return [].concat.apply([], paths)
  })
}

Archiver.prototype._createArchive = function(key) {
  let opts = {
    file: (name, options) => {
      return raf(p.join(this.root, name))
    }
  }

  let archive = key ? this.drive.createArchive(new Buffer(key, 'hex'), opts) : this.drive.createArchive(opts)

  archive.append = bluebird.promisify(archive.append)
  archive.download = bluebird.promisify(archive.download)
  archive.list = bluebird.promisify(archive.list)
  archive.finalize = bluebird.promisify(archive.finalize)

  return archive
}

/**
 * Only archive one file
 */
Archiver.prototype.archiveSolo = function(file, identifier) {
  let archive = this.drive.createArchive({
    file: (name, options) => {
      // If you are receiving a file in multiple pieces in a distributed system
      // it can be useful to write these pieces to disk one by one in various places
      // throughout the file without having to open and close a file descriptor all the time.
      // => raf (random-access-file)
      return raf(p.join(this.root, name))
    }
  });

  var stream  = archive.createFileWriteStream(identifier);

  return new Promise((resolve, reject) => {
    var file_stream = fs.createReadStream(file);

    file_stream.on('error', reject);
    file_stream.on('close', resolve);

    file_stream.pipe(stream);
  }).then(() => {
    return new Promise((resolve, reject) => {
      archive.finalize(function(e, d) {
        if (e) return reject(e);
        resolve(archive);
      });
    });
  })
}

Archiver.prototype.archive = function(directory, options) {
  let archive = this._createArchive()

  if (typeof(options) === 'undefined')
    options = {};

  directory = p.resolve(this.root, directory)

 return this._recursiveReaddir(directory, {
   maxDepth: options.maxDepth || Infinity,
   filters: options.filters || {},
   onFile: (f, stat) => {
     //rename file
     return archive.append(f.replace(this.root, ''))
   }
 })
 .then(function() {
   return archive.finalize()
    .then(() => Promise.resolve(archive))
 })
}

Archiver.prototype.spread = function(archive) {
  if (this.link) {
    console.log('Leave %s', this.link);
    this.interplanetary.leave(this.link)
  }

  this.link = archive.key.toString('hex')

  this.interplanetary.join(this.link)

  // archive.on('upload', function(data) {
  //   debug('uploading', data.length);
  // });

  this.interplanetary._stream = function() {
    // this is how the swarm and hyperdrive interface
    return archive.replicate()
  }

  return Promise.resolve(this.link)
}

function bytesToSize(bytes) {
  var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes == 0) return '0 Byte';
  var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
};

Archiver.prototype.download = function(link) {
  let archive = this._createArchive(link)

  return this.spread(archive)
    .then(() => {

      var acc = 0;
      var total = 0;

      archive.on('download', function(data) {
        acc += data.length;

        var ratio = Math.floor((acc / total) * 100)

        if (ratio % 20 == 0) {
          console.log('Download progress: %d%', ratio);
        }
      });

      archive.get(0, function(err, stat) {
        if (err) return console.error(err);
        total = stat.length;
      });

      return bluebird.map(archive.list(), function(e, i) {
        debug('Downloading a file of size %s', bytesToSize(e.length));
        return archive.download(i)
      })
    })
    .then(() => {
      return Promise.resolve()
    })
}