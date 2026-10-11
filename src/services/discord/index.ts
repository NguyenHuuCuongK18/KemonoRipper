// Discord keeps its existing durable jobs, pagination, DOM recovery, and download pipeline.
export { command, downloadChanged, recover, tick } from '../../background/controller';
