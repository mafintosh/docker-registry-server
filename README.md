# docker-registry-server

Docker registry implemented in Node.

```
npm install -g docker-registry-server
```

## Usage

To start it run

```
docker-registry-server
```

Currently data will be stored in `./layers` and `./db`.
For more info run `docker-registry-server --help`

## Authentication

Per default there is no authentication (meaning everyone can push/pull images).
You can use the `--user` command line option to limit registry access.

```
docker-registry-server --user mafintosh:secret --user another:hunter2
```

## Hooks

Similar to a git repository you can specify hooks that are executed when certain events happen.
Currently the following hooks are supported

* `tag (id, tag)` Triggered when an image is tagged (happens when you push a tagged image)
* `image (id)` Triggered when an image metadata is uploaded
* `layer (id)` Triggered when an image layer is uploaded
* `verify (id)` Triggered when an image layer+metadata has been verified
* `index (id)` Triggered when an image file system data has been indexed

The `tag` hook is especially useful as it allows you to set up a `push->deploy` flow.

To add a hook specify it as a command line argument prefixed with `--on-{name} {bash-script}`

```
docker-registry-server --on-tag "echo image \$1 was tagged with \$2 - please deploy"
```

Or add them in a `./hooks/{name}` file

## APIs

The registry should support all of the APIs specified in the [docker docs](https://docs.docker.com/reference/api/registry_api/).
In addition, the following APIs are available

#### `GET /v1/images/{id}/tree/{directory}`

Returns a JSON array containing the files/folders in `{directory}` in the image `{id}`.
Fx if you have an image, `4a21b50675ba611ab0e9236c4f9430348d932ea3bf6e9b2af86b47eca9088320` and you want to list
the files in `/root` do

```
curl localhost:8000/v1/images/4a21b50675ba611ab0e9236c4f9430348d932ea3bf6e9b2af86b47eca9088320/tree/root
```

#### `GET /v1/images/{id}/blobs/{filename}`

Get the file content of `{filename}` in the image `{id}`.
Fx if you have the same image as above and want to read `/root/package.json` do

```
curl localhost:8000/v1/images/4a21b50675ba611ab0e9236c4f9430348d932ea3bf6e9b2af86b47eca9088320/tree/root/package.json
```

## License

MIT