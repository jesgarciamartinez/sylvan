# Sylvan

## Why

Simplicity, performance, and low level control.
An experiment to find a "minimum viable framework".

## What it's for

- SPAs that require performance and control over the DOM.
- while not intended for the "JS sprinkles" approach – where JS only adds light interactivity for HTML returned from a server – it's possible to use Sylvan in this way, in a hopefully more principled, non ad-hoc way than using vanilla JS.
  

## How it works

- Components are implemented as classes with `create` / `mount` / `update` / `cleanup` methods
- The `create` method returns either a DOM Node or a _UITree_
  - returning a DOM Node allows for maximum flexibility – it can also find and return a Node already present in the DOM
  - a UITree is a tree of objects and arrays, similar to a VDOM, but with dynamic parts (conditionals and loops) encoded as part of the tree, with special components like `When` and `Each`, so *there is no diffing*.
  - each component's template is created once – overall in the app, not once per component instance. 
    Templates can have dynamic data in the form of `Hole`s (WIP – see below), just string refs to be used in `update()`.
- In the `update` method you write guards yourself – `if (changed(this, prop1, prop2)){}`) – this is similar to what Svelte compiles to (pre-v5, at least), or to the React Forget compiler.
- `mount` is just called once, when the component is appended to the DOM
- `cleanup` is called before every `update`

- There is a are-bones global state solution (see below)

## Why it works this way

Roughly speaking, if a component has a bunch of code and you only want to execute some of it when rerendering, you can either:
- 1. put that code in different functions. If you then track the data they access, you can execute only some of them. Tracking that data can
  be done statically (like React dependency arrays) or dynamically (like signals).
- 2. put code in a single function and reexecute all of it, but memoize parts – this is what React does with `useMemo`
- 3. put code in a single function, with different sections behind `if-guards`. This is what Svelte does (at least pre-v5, that has signals), and the React compiler also optimizes code this way. The `if` condition of the guards encodes the same information about dependencies as the tracked data would.

The single-function-with-guards approach has pros and cons
    - pro: 
        - it's simpler
        - consumes less memory
        - explicit order of execution
    - con: 
        - limits the expressivity of your templates. This is the biggest problem because it's a big DX hit.
        If you don't want to re-run your whole template (like React does with the VDOM), and unless you use a compiler (like Svelte), you are stuck with purely static templates with no dynamic parts, since they would need to be put into their own functions; so you must use refs to keep track of DOM nodes and component instances that change.
          - this is a big enough DX problem that Sylvan *also* has `Hole`s – so it's a mix between the 1st and 3rd approaches above.
        - it's annoying to type out, like React dependency arrays
        - explicit order of execution
        
_order of execution_ is listed both as a pro and a con.
Modern frameworks have tiered rerender execution, roughly: first pure computations, then DOM changes, then effects.
This is by necessity, since they take care of DOM updates, so your code must come before or after that, but in doing so they also prevent performance footguns. They encode best practices in their APIs by inverting control in this way – they impose limitations to give guarantees.

If the end-developer has control over update code, as is the case here, they must follow correct patterns to avoid problems like layout-thrashing.

## Example code

```tsx

// with ref and `update` with if-guard
class Counter extends Component {
  count = 0
  create(){
    return (
      <div>
        <span ref={'count_ref'} />
        <button click={this.increment}>Increment</button>
      </div>
    )
  }
  increment(){
    update(this, { count: this.count + 1 })
  }
  update(){
    if (changed('count')) this.count_ref.textContent = `count: ${this.count}`
  }
}

// with hole
class Counter extends Component {
  count = 0
  create(){
    return (
      <div>
        <span>{$(() => `count: ${inst.count}`)}</span>
        <button click={this.increment}>Increment</button>
      </div>
    )
  }
  increment(){
    update(this, { count: this.count + 1 })
  }
  
}

////

class ConditionalsAndLoopsExample extends Component {
  create() {
    return (
      <div>
        {$when(
          () => inst.list.length > 0,
          $each(
            () => inst.list,
            <div>
              <span>{$(() => itemInst.name)}</span>
              <span>{$(() => itemInst.age)}</span>
            </div>,
          ),
        )}
      </div>
    )
  }
}

```

## Should I use this

No, at least not right now. 
Sylvan is experimental, and some parts haven't been fully figured out yet.
You're welcome to try it, read through the source, ask questions, and report issues.

## WIP

### Holes

The idea is to have "holes" in the template, with functions that would run before `update()`.

```tsx
<div class={$(() => inst.selected ? 'active': '' )}/> // always executes
<div class={$(() => inst.selected ? 'active': '' , ['selected'])}/> // static dependencies – re-executes when 'selected' changes
<div class={$dyn(() => inst.selected ? 'active': '' )}/> // dynamic dependencies – inst becomes a proxy that tracks dependencies
```

This is how the framework first started out, before realizing that, really, _refs are all you need_.
Holes complicate the framework significantly, particularly in conditionals and loops, and increase memory consumption (since you'd be creating lots of these holes, where previously you'd have `if` guards).
However, they allow for much better DX.
Holes are currently being implemented.

### Global reactivity

- based on using a special `set` function that any regular obj / array / Map / Set can be mutated with, which causes all subscribed component's `update()` to run

## FAQ

- Does Sylvan have a virtual DOM? No. It uses a tree structure that is created once – in the whole app – for each component, and never diffed. It encodes dynamic parts, like loops, conditionals and slots, as components that are part of this tree. When a component is instantiated, Sylvan traverses the tree and creates DOM nodes and child components.

## Future directions

- Performance improvements: lots of possibilities here
  - when traversing the ui trees, cache ref paths so next time we can skip traversing and creating dom nodes one by one, and just clone a dom node and find the refs with the stored paths
    - e.g. this ui tree
      ```html
      <div>
        <div ref='1' />
        <div>
          <div ref='2' />
        </div>
      </div>
      ```
      would result a data structure like `{ 1: firstChild, 2: firstChild.nextSibling.firstChild }` (with some optimized format for the paths)
  - creating component instances while main thread is idle, and caching them
  - declaring some components as singleton so their DOM is only created once
  - more performant JSX transform, using arrays instead of objects to avoid triggering megamorphism




