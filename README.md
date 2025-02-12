# Fetch Fun

[![npm version](https://badge.fury.io/js/fetch-fun.svg)](https://badge.fury.io/js/fetch-fun)
[![Build Status](https://github.com/wmzy/fetch-fun/actions/workflows/ci.yml/badge.svg)](https://github.com/wmzy/fetch-fun/actions)
[![Coverage Status](https://coveralls.io/repos/github/wmzy/fetch-fun/badge.svg?branch=main)](https://coveralls.io/github/wmzy/fetch-fun?branch=main)

## Table of Contents

- [Description](#description)
- [Installation](#installation)
- [Usage](#usage)
- [Contributing](#contributing)
- [License](#license)

## Description

Fetch Fun is a lightweight library for making HTTP requests using the Fetch API. It provides a simple and intuitive interface for performing various types of HTTP requests, handling responses, and managing configurations.

## Installation

To install Fetch Fun, use npm or pnpm:

```bash
npm install fetch-fun
```

or

```bash
pnpm add fetch-fun
```

## Usage

Here is a basic example of how to use Fetch Fun:

```typescript
import * as ff from 'fetch-fun';

const fetchData = async () => {
  const client = ff.create()
    .with(ff.baseUrl, 'https://api.example.com/api/v1')
    .add(ff.header, 'Content-Type', 'application/json');

  ff.fetchJSON(client).then((data) => {
	  console.log(data);
  })
};
```

## Contributing

We welcome contributions to Fetch Fun! If you have any ideas, suggestions, or bug reports, please open an issue on our [GitHub repository](https://github.com/wmzy/fetch-fun/issues).

To contribute code, please follow these steps:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature-branch`).
3. Make your changes and commit them (`git commit -m 'Add new feature'`).
4. Push to the branch (`git push origin feature-branch`).
5. Open a pull request.

Please ensure your code adheres to our coding standards and includes appropriate tests.

## License

This project is licensed under the MIT License.
