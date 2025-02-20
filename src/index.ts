/**
 * TypeScript interface/type analyzer for project path
 */
//NPM Imports
import _ from "lodash";

//PKLIB Imports
import {
  getFilePaths, slashPath, dbgWrt, ask, runCli, sassMapStringToJson, sassMapStringToObj, saveData, isFile, getOsType, isWindows, isLinux, runCommand, stdOut, winBashes, argv, isSimpleObject, PkError, multiAsk, parseArgs, getArrArgs, getObjArg, askConfirm,
  writeData, pkToDate, dtFmt, GenObj,
   setInspectLevels,
} from 'pk-ts-node-lib';

setInspectLevels();
//Local Imports

import {TypeScriptAnalyzer,
} from './analyzer.js';

//const commonPath = "C:/www/TypeScriptLibs/Pk-Ts-Common"
const commonPath = "C:/www/TypeScriptLibs/Pk-Ts-Node"

let cmAn = new TypeScriptAnalyzer(commonPath);
let proj = cmAn.project;

let srcs = cmAn.listSourceFiles();
let interfaces = cmAn.listInterfaceNames();
let types = cmAn.listTypeNames();
let analysis = cmAn.analyze();
console.log({
  //srcs,
  //interfaces,
  //types,
  analysis,
});

dbgWrt(analysis,'NodeLibTypes');
