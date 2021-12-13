import 'regenerator-runtime/runtime.js';
import * as NewIngestion from './newingestion.js';
import { eachSeries } from 'async';
// import { createReadStream, createWriteStream, statSync, unlinkSync } from 'fs';
import fs from 'fs';
import path from 'path';
import { chain } from 'stream-chain';
import { isZipSync } from 'is-zip-file';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick';
import { ignore } from 'stream-json/filters/Ignore';
import { streamValues } from 'stream-json/streamers/StreamValues';
import unzipper from 'unzipper';
import neo4j from 'neo4j-driver';
import 'core-js/features/array/flat-map';
import sanitize from 'sanitize-filename';
import { basename } from 'path';
import Mutex from 'await-mutex';
import chokidar from 'chokidar';

const INPUT_FOLDER = process.env.INPUT_FOLDER || './data/*';
const NEO4J_URL = process.env.NEO4J_URL || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'bloodhound';
const DELETE_PROCESSED = process.env.DELETE_PROCESSED || true;

String.prototype.format = function () {
    var i = 0,
        args = arguments;
    return this.replace(/{}/g, function () {
        return typeof args[i] !== 'undefined' ? args[i++] : '';
    });
};
String.prototype.formatAll = function () {
    var args = arguments;
    return this.replace(/{}/g, args[0]);
};
String.prototype.formatn = function () {
    var formatted = this;
    for (var i = 0; i < arguments.length; i++) {
        var regexp = new RegExp('\\{' + i + '\\}', 'gi');
        formatted = formatted.replace(regexp, arguments[i]);
    }
    return formatted;
};
Array.prototype.chunk = function () {
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
    Array.prototype.last = function () {
        return this[this.length - 1];
    };
}

const FileStatus = Object.freeze({
    ParseError: 0,
    InvalidVersion: 1,
    BadType: 2,
    Waiting: 3,
    Processing: 4,
    Done: 5,
    NoData: 6,
});

const IngestFuncMap = {
    computers: NewIngestion.buildComputerJsonNew,
    groups: NewIngestion.buildGroupJsonNew,
    users: NewIngestion.buildUserJsonNew,
    domains: NewIngestion.buildDomainJsonNew,
    ous: NewIngestion.buildOuJsonNew,
    gpos: NewIngestion.buildGpoJsonNew,
    azdevices: NewIngestion.buildAzureDevices,
    azusers: NewIngestion.buildAzureUsers,
    azgroups: NewIngestion.buildAzureGroups,
    aztenants: NewIngestion.buildAzureTenants,
    azsubscriptions: NewIngestion.buildAzureSubscriptions,
    azresourcegroups: NewIngestion.buildAzureResourceGroups,
    azvms: NewIngestion.buildAzureVMs,
    azkeyvaults: NewIngestion.buildAzureKeyVaults,
    azgroupowners: NewIngestion.buildAzureGroupOwners,
    azgroupmembers: NewIngestion.buildAzureGroupMembers,
    azvmpermissions: NewIngestion.buildAzureVmPerms,
    azrgpermissions: NewIngestion.buildAzureRGPermissions,
    azkvpermissions: NewIngestion.buildAzureKVPermissions,
    azkvaccesspolicies: NewIngestion.buildAzureKVAccessPolicies,
    azpwresetrights: NewIngestion.buildAzurePWResetRights,
    azgroupsrights: NewIngestion.buildAzureGroupRights,
    azglobaladminrights: NewIngestion.buildAzureGlobalAdminRights,
    azprivroleadminrights: NewIngestion.buildAzurePrivRileAdminRights,
    azapplicationadmins: NewIngestion.buildAzureApplicationAdmins,
    azcloudappadmins: NewIngestion.buildAzureCloudApplicationAdmins,
    azapplicationowners: NewIngestion.buildAzureAppOwners,
    azapplicationtosp: NewIngestion.buildAzureAppToSP,
};
let fileId = {
    current: 0,
};

var driver = neo4j.driver(
    NEO4J_URL,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    {
        disableLosslessIntegers: true,
        connectionTimeout: 120000,
    }
);

let watcher = chokidar.watch(INPUT_FOLDER);
let mutex = new Mutex();

watcher.on('add', async (path) => {
    console.log('New file: {}'.format(path));
    const file = {
        path: path,
        name: basename(path),
    };
    let unlock = await mutex.lock();
    processFiles([file], unlock);
});

const processFiles = async (fileNames, unlock) => {
    // console.log('fileNames', fileNames);
    const results = await unzipFiles(fileNames);
    // console.log('results', results);
    for (const file of Object.values(results)) {
        var msg = 'Processing file {}'.format(file.name);
        if (file.zip_name) {
            msg += ' from {}'.format(file.zip_name);
        }
        msg += ' ({} {} objects)'.format(file.count, file.type);
        console.log(msg);
        if (file.status != FileStatus.Waiting) {
            console.log('Invalid file: {}'.format(file.name));
            continue;
        }

        await processJson(file);

        if (file.delete) {
            console.log('Deleting file {}'.format(file.path));
            fs.unlinkSync(file.path);
        }
    }

    for (const file of fileNames) {
        if (DELETE_PROCESSED) {
            console.log('Deleting file {}'.format(file.path));
            fs.unlinkSync(file.path);
        }
    }
    
    console.log('Finished processing files');
    unlock();

    // eachSeries(
    //     results,
    //     (file) => {
            
    //     },
    //     () => {
    //         console.log(results, fileNames);
    //         //addBaseProps();
    //         for (const file of results) {
               
    //         }
            


    //     }
    // );
};

// async function addBaseProps() {
//     let s = driver.session();
//     await s.run(
//         'MATCH (n:User) WHERE NOT EXISTS(n.owned) SET n.owned=false'
//     );
//     await s.run(
//         'MATCH (n:Computer) WHERE NOT EXISTS(n.owned) SET n.owned=false'
//     );

//     await s.run(
//         'MATCH (n:Group) WHERE n.objectid ENDS WITH "-513" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-1-0" MERGE (n)-[r:MemberOf]->(m)'
//     );

//     await s.run(
//         'MATCH (n:Group) WHERE n.objectid ENDS WITH "-515" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-1-0" MERGE (n)-[r:MemberOf]->(m)'
//     );

//     await s.run(
//         'MATCH (n:Group) WHERE n.objectid ENDS WITH "-513" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-5-11" MERGE (n)-[r:MemberOf]->(m)'
//     );

//     await s.run(
//         'MATCH (n:Group) WHERE n.objectid ENDS WITH "-515" MATCH (m:Group) WHERE m.domain=n.domain AND m.objectid ENDS WITH "S-1-5-11" MERGE (n)-[r:MemberOf]->(m)'
//     );
//     s.close();
// }

const unzipFiles = async (files) => {
    let finalFiles = [];
    var tempPath = path.resolve('/tmp');
    for (let file of files) {
        let fPath = file.path;
        let name = file.name;

        if (isZipSync(fPath)) {
            console.log(`Unzipping file ${name}`);
            const zip = fs
                .createReadStream(fPath)
                .pipe(unzipper.Parse({ forceStream: true }));

            for await (const entry of zip) {
                let sanitizedPath = sanitize(entry.path);
                let output = path.join(tempPath, sanitizedPath);

                let success = await new Promise((resolve, reject) => {
                    let st = fs.createWriteStream(output);
                    st.on('error', (err) => {
                        console.error(err);
                        resolve(false);
                    });

                    st.on('finish', () => {
                        resolve(true);
                    });

                    entry.pipe(st);
                });

                if (success) {
                    finalFiles.push({
                        path: output,
                        name: sanitizedPath,
                        zip_name: name,
                        delete: true,
                        id: fileId.current,
                    });
                    fileId.current += 1;
                }
            }
        } else {
            finalFiles.push({
                path: fPath,
                name: name,
                delete: false,
                id: fileId.current,
            });
            fileId.current += 1;
        }
    }

    return checkFileValidity(finalFiles);
};

const getMetaTagQuick = async (file) => {
    let size = fs.statSync(file.path).size;
    let start = size - 300;
    if (start <= 0) {
        start = 0;
    }

    //Try end of file first
    let prom = new Promise((resolve, reject) => {
        fs.createReadStream(file.path, {
            encoding: 'utf8',
            start: start,
            end: size,
        }).on('data', (chunk) => {
            let type, version, count;
            try {
                type = /type.?:\s?"(\w*)"/g.exec(chunk)[1];
                count = parseInt(/count.?:\s?(\d*)/g.exec(chunk)[1]);
            } catch (e) {
                type = null;
                count = null;
            }
            try {
                version = parseInt(/version.?:\s?(\d*)/g.exec(chunk)[1]);
            } catch (e) {
                version = null;
            }

            resolve({
                count: count,
                type: type,
                version: version,
            });
        });
    });

    let meta = await prom;
    if (meta.type !== null && meta.count !== null) {
        return meta;
    }

    //Try the beginning of the file next
    prom = new Promise((resolve, reject) => {
        fs.createReadStream(file.path, {
            encoding: 'utf8',
            start: 0,
            end: 300,
        }).on('data', (chunk) => {
            let type, version, count;
            try {
                type = /type.?:\s+"(\w*)"/g.exec(chunk)[1];
                count = parseInt(/count.?:\s+(\d*)/g.exec(chunk)[1]);
            } catch (e) {
                type = null;
                count = null;
            }
            try {
                version = parseInt(/version.?:\s+(\d*)/g.exec(chunk)[1]);
            } catch (e) {
                version = null;
            }

            resolve({
                count: count,
                type: type,
                version: version,
            });
        });
    });

    meta = await prom;
    return meta;
};

const checkFileValidity = async (files) => {
    let filteredFiles = {};
    for (let file of files) {
        let meta = await getMetaTagQuick(file);
        // const pipeline = chain([
        //     fs.createReadStream(file.path, { encoding: 'utf8' }),
        //     parser(),
        //     pick({ filter: 'meta' }),
        //     ignore({ filter: 'data' }),
        //     streamValues(),
        //     (data) => {
        //         const value = data.value;
        //         return value;
        //     },
        // ]);

        // alert.info(`Validating file ${file.name}`);

        // let meta;
        // try {
        //     for await (let data of pipeline) {
        //         meta = data;
        //     }
        // } catch (e) {
        //     console.log(e);
        //     filteredFiles[file.id] = {
        //         ...file,
        //         status: FileStatus.ParseError,
        //     };
        //     continue;
        // }

        if (!('version' in meta) || meta.version < 3) {
            filteredFiles[file.id] = {
                ...file,
                status: FileStatus.InvalidVersion,
            };
            continue;
        }

        if (!Object.keys(IngestFuncMap).includes(meta.type)) {
            console.log(meta.type);
            filteredFiles[file.id] = {
                ...file,
                status: FileStatus.BadType,
            };
            continue;
        }

        filteredFiles[file.id] = {
            ...file,
            status: meta.count > 0 ? FileStatus.Waiting : FileStatus.NoData,
            count: meta.count,
            type: meta.type,
            progress: 0,
        };
    }

    return filteredFiles;
    // setFileQueue((state) => {
    //     return { ...state, ...filteredFiles };
    // });
};

// const getFileMeta = async (file, callback) => {
//     console.log('Uploading');

//     let size = fs.statSync(file).size;
//     let start = size - 200;
//     if (start <= 0) {
//         start = 0;
//     }

//     fs.createReadStream(file, {
//         encoding: 'utf8',
//         start: start,
//         end: size,
//     }).on('data', (chunk) => {
//         let type, version, count;
//         try {
//             type = /type.?:\s?"(\w*)"/g.exec(chunk)[1];
//             count = /count.?:\s?(\d*)/g.exec(chunk)[1];
//         } catch (e) {
//             type = null;
//             count = null;
//         }
//         try {
//             version = /version.?:\s?(\d*)/g.exec(chunk)[1];
//         } catch (e) {
//             version = null;
//         }

//         if (version == null) {
//             console.error(
//                 'Version 2 data is not compatible with BloodHound v3.'
//             );
//             console.log('Stopped upload');
//             callback();
//             return;
//         }

//         if (!Object.keys(IngestFuncMap).includes(type)) {
//             console.error('Unrecognized File');
//             console.log('Stopped upload');
//             callback();
//             return;
//         }
//         processJson(file, callback, parseInt(count), type, version);
//     });
// };

const processJson = async (file) => {
    file.status = FileStatus.Processing;
    // setFileQueue((state) => {
    //     return { ...state, [file.id]: file };
    // });
    console.log(`Processing ${file.name}`);
    console.time('IngestTime');
    let tag;
    if (file.type.startsWith('az')) {
        tag = 'data';
    } else {
        tag = file.type;
    }
    const pipeline = chain([
        fs.createReadStream(file.path, { encoding: 'utf8' }),
        parser(),
        pick({ filter: tag }),
        ignore({ filter: 'meta' }),
        streamValues(),
        (data) => {
            const value = data.value;
            return value;
        },
    ]);

    let count = 0;
    let chunk = [];
    let processor = IngestFuncMap[file.type];
    try {
        for await (let data of pipeline) {
            chunk.push(data);
            count++;

            if (count % 5 === 0) {
                pipeline.pause();
                let data = processor(chunk);
                for (let key in data) {
                    if (data[key].props.length === 0) continue;
                    let cData = data[key].props.chunk();
                    let statement = data[key].statement;

                    for (let c of cData) {
                        await uploadData(statement, c);
                        //await sleep_test(100);
                    }
                }
                file.progress = count;
                // setFileQueue((state) => {
                //     return { ...state, [file.id]: file };
                // });
                chunk = [];
                pipeline.resume();
            }
        }

        let data = processor(chunk);
        for (let key in data) {
            if (data[key].props.length === 0) continue;
            let cData = data[key].props.chunk();
            let statement = data[key].statement;

            for (let c of cData) {
                await uploadData(statement, c);
            }
        }
        file.progress = count;
        file.status = FileStatus.Done;
        // setUploading(false);
        // setFileQueue((state) => {
        //     return { ...state, [file.id]: file };
        // });

        console.timeEnd('IngestTime');
        // emitter.emit('refreshDBData');
    } catch (e) {
        console.log(e);
    }
};

const uploadData = async (statement, props) => {
    let session = driver.session();
    await session.run(statement, { props: props }).catch((err) => {
        console.log(statement);
        console.log(err);
    });
    session.close();
};
