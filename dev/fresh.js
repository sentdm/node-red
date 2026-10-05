'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {startDemo}=require('./demo');
const directory=fs.mkdtempSync(path.resolve('.fresh-'));
startDemo({directory,fresh:true}).catch(e=>{console.error(e.message);process.exitCode=1;});
