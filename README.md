# sylvan

## Why

Simplicity, performance, and low level control that other frameworks get in the way of.
An experiment to find a "minimum viable framework"

## What it's for

- SPAs that require performance and control over the DOM.
- while not intended for the "JS sprinkles" approach – where JS only adds light interactivity for HTML returned from a server – it's possible to use Sylvan in this way, in a hopefully more pricipled, non ad-hoc way than using vanilla JS.
  - Nice story around that because components can act on existing DOM (create can return existing DOM), and the mental model (refs) is similar to vanilla JS.

## How it works

- Components are implemented as classes with create/mount/update/cleanup methods
- The create method returns either a DOM node or a _UITree_ 
  - a UITree is a tree of objects and arrays, similar to a VDOM, but with dynamic parts encoded as part of the tree, with special components like `Each` and `When`, so *there is no diffing*.
  - each component's template is created once – overall, not once per comp instance. There is no dynamic data in templates, just string refs to be used in `update()`.
- In the update fn you write guards yourself – `if (changed(this, prop1, prop2)){}`)  // — this is similar to what Svelte compiles to (pre-v5, at least), or to the React Forget compiler.


- There is a very bare-bones global state solution (more on that below)
  - whole comp instances subscribe to it
  - any regular obj/array/Map/Set can be mutated with a special `set` function, and all subscribed component's `update()` will run

## Why it works this way

Roughly speaking, if a component has a bunch of code and you only want to execute some of it when rerendering, you can either:
- put that code in different functions. If you then track the data they access, you can execute only some of them. Tracking that data can
  be done statically (like React dependency arrays) or dynamically (like signals).
- execute all, but memoize parts
- put the different code sections behind `if` guards. This is what Svelte does (at least pre-v5, that has signals), and the React compiler also optimizes code this way. 
  The `if` condition of the guards encodes the same information about dependencies as the tracked data would.
  That way you can have all your update code in a single function with guards

The guarding approach in a has pros and cons
    - pro: 
        - it's simpler
        - consumes less memory
        - explicit order of execution
    - con: 
        - limits the expressivity of your templates. This is the biggest problem because it's a big DX hit.
        If you don't want to re-run your whole template (like React does with the VDOM), and unless you use a compiler (like Svelte), you are stuck with purely static templates with no dynamic parts, since they would need to be put into their own functions; so you must use refs to keep track of DOM nodes and component instances that change.
        - it's annoying to type out, like React dependency arrays
        - explicit order of execution
        
_order of execution_ is listed both as a pro and a con.
Modern frameworks have tiered rerender execution, roughly: first pure computations, then DOM changes, then effects.
This is by necessity, since they take care of DOM updates, so your code must come before or after that, but in doing so they also prevent performance footguns. They encode best practices in their APIs by inverting control in this way – they impose limitations to give guarantees.

If the end-developer has control over update code, as is the case here, they must follow correct patterns to avoid problems like layout-thrashing.


```ts
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

////
  
class ConditionalsAndLoopsExample extends Component {
  create() {
    return (
      <div>
        {$when(
          'show_list',
          $each(
            'item_in_list',
            <div>
              <span ref="name_ref"></span>
              <span ref="age_ref"></span>
            </div>,
            function () {
              this.name_ref.textContent = this.name
              this.age_ref.textContent = this.age
            },
          ),
        )}
      </div>
    )
  }

  update() {
    if (c(this, 'list')) {
      const show_list = this.list.length > 0
      if (when(show_list, 'show_list')) {
        if (show_list) each('item_in_list', this.list)
      }
    }
  }
}

class ConditionalsAndLoopsExample extends Component {
  create() {
    // return (
    //   <div>
    //     {$when(
    //       () => inst.list.length > 0,
    //       $each(
    //         () => inst.list,
    //         <div>
    //           <span ref="name_ref">{$(() => inst.name)}</span>
    //           <span ref="age_ref">{$(() => inst.age)}</span>
    //         </div>,
    //       ),
    //     )}
    //   </div>
    // )
    return (
      <When
        test={}
        then={
          <Each array={() => inst.list}>
            <div>
              <span>{$(() => item.name)}</span>
              <span>{$(() => item.age)}</span>
            </div>
          </Each>
        }
      />
    )
  }
}

```

## Should I use this

Not right now. Sylvan is experimental, and some parts haven't been fully figured out yet.
You're welcome to try it, read through the source, ask questions, and report issues.

## FAQ

- Does Sylvan have a virtual DOM? No. The tree structure it uses is only created once per component, and never diffed.
- It uses a tree structure that is created once – in the whole app – for each component, and encodes dynamic parts, like loops, conditionals and slots, as components that are part of this tree. When a component is instantiated, sylvan traverses the tree and creates DOM nodes and child components.

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
  - creating instances when idle and caching them
  - declaring some components as singleton so their DOM is only created once
  - more performant JSX transform, using arrays instead of objects to avoid triggering megamorphism

- Holes
  - This is how the framework first started out, before realizing that, really, _refs are all you need_.
  - The idea would be to have Holes in the template, with fns that would run before or after `update()`, probably with dynamic dependencies (like signals)
  - it complicates the framework significantly, particularly in conditionals and loops, and "only" for better DX. 
  - it would increase memory consumption (since you'd be creating lots of these holes, where previously you'd have `if` guards)
  - 
    - holes = Map<Inst|Node, Hole[]> -> before update, can lead to creating partials ->
    - dynamic_holes_from_partials = Map<Inst|Node, Hole[]> -> before update
      - need to be attached to owner, so they can reexecute, otherwise e.g. a hole in the then-branch of a When won't run again
      + or attach partials in a Set<PartialInst> to owner, see if they have holes

### 





