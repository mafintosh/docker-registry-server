whale build mafintosh/docker-registry
whale push mafintosh/docker-registry
whale -H mathiasbuus.eu pull mafintosh/docker-registry
whale -H mathiasbuus.eu stop mafintosh/docker-registry
whale -H mathiasbuus.eu start mafintosh/docker-registry -v /root/docker-registry:/tmp/docker-registry -e PORT=80 --fork
