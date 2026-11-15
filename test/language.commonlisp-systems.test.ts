import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commonLispRegistry } from '../src/language/commonlisp-systems.ts';
import { executeBounded, privateEnvironment, temporaryDirectory, sha256 } from '../src/lisp/runtime.ts';

test('real SBCL resolves missing nested Lem secondary system after explicit ASDF registry repair', async () => {
  const root=temporaryDirectory('modkh-asdf-');
  try {
    const projects=path.join(root,'projects');
    const lem=path.join(projects,'lem/extensions/language-server');fs.mkdirSync(lem,{recursive:true});
    fs.writeFileSync(path.join(lem,'lem-language-server.asd'),'(asdf:defsystem "lem-language-server")\n(asdf:defsystem "lem-language-server/cli" :depends-on ("lem-language-server"))');
    // An incomplete source-registry cache must not hide this nested system.
    fs.writeFileSync(path.join(projects,'.cl-source-registry.cache'),'()');
    const registry=commonLispRegistry(projects);
    const driver=`(require :asdf)
(asdf:initialize-source-registry '(:source-registry :ignore-inherited-configuration))
(assert (null (asdf:find-system "lem-language-server/cli" nil)))
(asdf:clear-source-registry)
(asdf:initialize-source-registry '${registry})
(assert (asdf:find-system "lem-language-server/cli"))
(write-line "MODKH_ASDF_REPAIRED")`;
    fs.writeFileSync(path.join(root,'probe.lisp'),driver);
    const result=await executeBounded('sbcl',['--noinform','--no-sysinit','--no-userinit','--disable-debugger','--script','probe.lisp'],{cwd:root,env:privateEnvironment(root),inputDigest:sha256(driver),timeoutMs:10000});
    assert.equal(result.state,'exited',result.stderr);assert.equal(result.exitCode,0,result.stderr);
    assert.equal(result.stdout.trim(),'MODKH_ASDF_REPAIRED');assert.equal(result.cleanup,'settled');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('dependency registry ignores symlinks and Git metadata', () => {
  const root=temporaryDirectory('modkh-asdf-boundary-');
  try {
    fs.mkdirSync(path.join(root,'source'));fs.writeFileSync(path.join(root,'source','owned.asd'),'');
    fs.mkdirSync(path.join(root,'.git'));fs.writeFileSync(path.join(root,'.git','hidden.asd'),'');
    fs.symlinkSync(path.join(root,'.git'),path.join(root,'linked'));
    const registry=commonLispRegistry(root);
    assert.match(registry,/source/);assert.doesNotMatch(registry,/linked|\.git/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('real SBCL reports missing micros and loads it after dependency registry repair', async () => {
  const root = temporaryDirectory('modkh-micros-');
  try {
    const source = path.join(root, 'micros'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'micros.asd'), '(asdf:defsystem "micros" :components ((:file "server")))');
    fs.writeFileSync(path.join(source, 'server.lisp'), '(defpackage :micros (:use :cl) (:export :create-server))\n(in-package :micros)\n(defun create-server () :fixture)');
    const driver = `(require :asdf)
(asdf:initialize-source-registry '(:source-registry :ignore-inherited-configuration))
(handler-case (progn (asdf:load-system "micros") (error "unexpected dependency"))
  (asdf:missing-component () (write-line "MICROS_MISSING")))
(asdf:clear-source-registry)
(asdf:initialize-source-registry '${commonLispRegistry(root)})
(asdf:load-system "micros")
(assert (eq :fixture (uiop:symbol-call :micros :create-server)))
(write-line "MICROS_LOADED")`;
    fs.writeFileSync(path.join(root, 'probe.lisp'), driver);
    const result = await executeBounded('sbcl', ['--noinform', '--no-sysinit', '--no-userinit', '--disable-debugger', '--script', 'probe.lisp'],
      { cwd: root, env: privateEnvironment(root), inputDigest: sha256(driver), timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.cleanup, 'settled');
    assert.match(result.stdout, /MICROS_MISSING/); assert.match(result.stdout, /MICROS_LOADED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
