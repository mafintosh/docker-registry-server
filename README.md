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

## Peerca support

[Peerca](https://github.com/substack/peerca) certificates are supported using the `--cert [host]` argument

```
peerca generate -h my-registry.com
docker-registry-server --cert my-registry.com
```

See the peerca docs for info on how to add your client certificate.

## License

MIT