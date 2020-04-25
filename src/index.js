import * as NewIngestion from './newingestion.js';
import { eachSeries } from 'async';
import { createReadStream, createWriteStream, statSync, unlinkSync } from 'fs';
import { chain } from 'stream-chain';
import { isZipSync } from 'is-zip-file';
import { withParser } from 'stream-json/filters/Pick';
import { Parse } from 'unzipper';
import { streamArray } from 'stream-json/streamers/StreamArray';
import neo4j from 'neo4j-driver';
import "core-js/features/array/flat-map";
import sanitize from 'sanitize-filename';
import { join, basename } from 'path';
import watch from 'glob-watcher';
import Mutex from 'await-mutex'

const INPUT_FOLDER = process.env.INPUT_FOLDER || './sample/*';
const NEO4J_URL = process.env.NEO4J_URL || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'bloodhound';
const DELETE_PROCESSED = process.env.DELETE_PROCESSED || true;

String.prototype.format = function() {
    var i = 0,
        args = arguments;
    return this.replace(/{}/g, function() {
        return typeof args[i] !== 'undefined' ? args[i++] : '';
    });
};
String.prototype.formatAll = function() {
    var args = arguments;
    return this.replace(/{}/g, args[0]);
};
String.prototype.formatn = function() {
    var formatted = this;
    for (var i = 0; i < arguments.length; i++) {
        var regexp = new RegExp('\\{' + i + '\\}', 'gi');
        formatted = formatted.replace(regexp, arguments[i]);
    }
    return formatted;
};
Array.prototype.chunk = function() {
    let i = 0;
    let len = this.length;
    let temp = [];
    let chunkSize = 10000;

    for (i = 0; i < len; i += chunkSize) {
        temp.push(this.slice(i, i + chunkSize));
    }

    return temp;
};
if (!Array.prototype.last) {
    Array.prototype.last = function() {
        return this[this.length - 1];
    };
}

var driver = neo4j.driver(
    NEO4J_URL,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    {
        disableLosslessIntegers: true,
        connectionTimeout: 120000,
    }
);

let fileNames = [];
let watcher = watch(INPUT_FOLDER, function(done){
  done();
});
let mutex = new Mutex();

watcher.on('add', async function (path, stat) {
  console.log('New file: {}'.format(path));
  const file = {
    path: path,
    name: basename(path)
  }
  let unlock = await mutex.lock();
  processFiles([file], unlock);
})


function processFiles(fileNames, unlock) {

    unzipNecessary(fileNames).then((results) => {
        eachSeries(
            results,
            (file, callback) => {
                var msg = 'Processing file {}'.format(file.name);
                if (file.zip_name) {
                    msg += ' from {}'.format(file.zip_name);
                }
                console.log(msg);
                getFileMeta(file.path, callback);
            },
            () => {
                addBaseProps();
                results.forEach((file, i) => {
                  console.log('Deleting file {}'.format(file.path));
                  if(file.delete) {
                    unlinkSync(file.path);
                  }
                });
                fileNames.forEach((file, i) => {
                  console.log('Deleting file {}'.format(file.path));
                  if(DELETE_PROCESSED) {
                    unlinkSync(file.path);
                  }
                });

                console.log('Finished processing all files');
                unlock();
            }
        );
    });
}

async function addBaseProps() {
    let s = driver.session();
    await s.run(
        'MATCH (n:User) WHERE NOT EXISTS(n.owned) SET n.owned=false'
    );
    await s.run(
        'MATCH (n:Computer) WHERE NOT EXISTS(n.owned) SET n.owned=false'
    );

    await s.run(
        'MATCH (n:Group) WHERE n.objectid ENDS WITH "-513" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-1-0" MERGE (n)-[r:MemberOf]->(m)'
    );

    await s.run(
        'MATCH (n:Group) WHERE n.objectid ENDS WITH "-515" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-1-0" MERGE (n)-[r:MemberOf]->(m)'
    );

    await s.run(
        'MATCH (n:Group) WHERE n.objectid ENDS WITH "-513" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-5-11" MERGE (n)-[r:MemberOf]->(m)'
    );

    await s.run(
        'MATCH (n:Group) WHERE n.objectid ENDS WITH "-515" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-5-11" MERGE (n)-[r:MemberOf]->(m)'
    );
    s.close();
}

async function unzipNecessary(files) {
    var index = 0;
    var processed = [];
    var tempPath = './temp';
    let promises = [];
    while (index < files.length) {
        var path = files[index].path;
        var name = files[index].name;

        if (isZipSync(path)) {
            var alert = console.log('Unzipping file {}'.format(name));

            await createReadStream(path)
                .pipe(Parse())
                .on('error', function (error) {
                    console.log('{} is corrupted or password protected'.format(name));
                })
                .on('entry', function (entry) {
                    let sanitized = sanitize(entry.path);
                    let output = join(tempPath, sanitized);
                    let write = entry.pipe(createWriteStream(output));

                    let promise = new Promise((res) => {
                        write.on('finish', () => {
                            res();
                        });
                    });

                    promises.push(promise);
                    processed.push({
                        path: output,
                        name: sanitized,
                        zip_name: name,
                        delete: true,
                    });
                })
                .promise();
        } else {
            processed.push({ path: path, name: name, delete: false });
        }
        index++;
    }
    await Promise.all(promises);
    return processed;
}

function getFileMeta(file, callback) {

    let acceptableTypes = [
        'sessions',
        'ous',
        'groups',
        'gpomembers',
        'gpos',
        'computers',
        'users',
        'domains',
    ];
    let count;

    console.log('Uploading');

    let size = statSync(file).size;
    let start = size - 200;
    if (start <= 0) {
        start = 0;
    }

    createReadStream(file, {
        encoding: 'utf8',
        start: start,
        end: size,
    }).on('data', (chunk) => {
        let type, version;
        try {
            type = /type.?:\s?"(\w*)"/g.exec(chunk)[1];
            count = /count.?:\s?(\d*)/g.exec(chunk)[1];
        } catch (e) {
            type = null;
        }
        try {
            version = /version.?:\s?(\d*)/g.exec(chunk)[1];
        } catch (e) {
            version = null;
        }

        if (version == null) {
            console.error(
                'Version 2 data is not compatible with BloodHound v3.'
            );
            console.log('Stopped upload');
            callback();
            return;
        }

        if (!acceptableTypes.includes(type)) {
            console.error('Unrecognized File');
            console.log('Stopped upload');
            callback();
            return;
        }
        processJson(file, callback, parseInt(count), type, version);
    });
}

function processJson(file, callback, count, type, version = null) {
    console.log('processJson', file, count, type, version);
    let pipeline = chain([
        createReadStream(file, { encoding: 'utf8' }),
        withParser({ filter: type }),
        streamArray(),
    ]);

    let localcount = 0;
    let sent = 0;
    let chunk = [];
    //Start a timer for fun

    console.log(`Processing ${file}`);
    console.time('IngestTime');
    pipeline
        .on(
            'data',
            async function (data) {
                chunk.push(data.value);
                localcount++;
                if (localcount % 1000 === 0) {
                    pipeline.pause();
                    console.log(data);
                    await uploadData(chunk, type, version);
                    sent += chunk.length;
                    // this.setState({
                    //     progress: Math.floor((sent / count) * 100),
                    // });
                    chunk = [];
                    pipeline.resume();
                }
            }
        )
        .on(
            'end',
            async function () {
                await uploadData(chunk, type, version);
                //emitter.emit('refreshDBData');
                console.timeEnd('IngestTime');
                callback();
            }
        );
}

async function uploadData(chunk, type, version) {
    let session = driver.session();
    let funcMap;
    if (version == null) {
        funcMap = {
            computers: OldIngestion.buildComputerJson,
            domains: OldIngestion.buildDomainJson,
            gpos: OldIngestion.buildGpoJson,
            users: OldIngestion.buildUserJson,
            groups: OldIngestion.buildGroupJson,
            ous: OldIngestion.buildOuJson,
            sessions: OldIngestion.buildSessionJson,
            gpomembers: OldIngestion.buildGpoAdminJson,
        };
    } else {
        funcMap = {
            computers: NewIngestion.buildComputerJsonNew,
            groups: NewIngestion.buildGroupJsonNew,
            users: NewIngestion.buildUserJsonNew,
            domains: NewIngestion.buildDomainJsonNew,
            ous: NewIngestion.buildOuJsonNew,
            gpos: NewIngestion.buildGpoJsonNew,
        };
    }

    let data = funcMap[type](chunk);
    for (let key in data) {
        if (data[key].props.length === 0) {
            continue;
        }
        let arr = data[key].props.chunk();
        let statement = data[key].statement;
        for (let i = 0; i < arr.length; i++) {
            await session
                .run(statement, { props: arr[i] })
                .catch(function (error) {
                    console.log(statement);
                    console.log(data[key].props);
                    console.log(error);
                });
        }
    }

    session.close();
}
