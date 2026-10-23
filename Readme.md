OrchestrOS 🚀

Intelligent Container Orchestration with Resource-Aware Scheduling and Auto Scaling

OrchestrOS is a software project that demonstrates operating system concepts through an intelligent container orchestration platform. It aims to manage job execution, allocate computing resources efficiently, monitor worker health, detect failures, and support automatic scaling based on system workload.

The project combines Operating Systems, Database Management Systems, Docker, and Web Development to demonstrate how computing workloads can be managed through a centralized orchestration system.

📌 Project Overview

Modern computing systems need efficient ways to schedule tasks, allocate resources, and handle failures. OrchestrOS explores these challenges through a modular architecture that integrates job management, worker coordination, container execution, and resource monitoring.

The platform is designed to provide a foundation for experimenting with scheduling algorithms, resource-aware task placement, failure detection, and autoscaling strategies.

Repository: Pranjalgit1/OrchestrOS

🎯 Objectives

* Implement core operating system concepts in a practical application.
* Manage job creation, execution, and lifecycle transitions.
* Explore CPU scheduling and resource allocation strategies.
* Integrate Docker for isolated workload execution.
* Detect worker or job failures and support recovery mechanisms.
* Use database transactions to maintain consistent system state.
* Monitor workload metrics and resource utilization.
* Explore automatic scaling based on workload demand.

✨ Key Features

1. Job Management

* Create and manage computational jobs.
* Track job lifecycle states.
* Validate job state transitions.
* Support job cancellation.
* Expose APIs for interacting with job records.

2. Scheduling and Resource Allocation

* Provide a foundation for CPU scheduling algorithms.
* Explore First Come, First Served (FCFS), Shortest Job First (SJF), Priority Scheduling, and Round Robin.
* Investigate resource-aware placement strategies, including First Fit and Least Loaded approaches.
* Support experiments involving scheduling fairness and workload distribution.

The availability of individual algorithms depends on their implementation in the current codebase.

3. Docker Integration

* Use Docker containers to execute workloads in an isolated environment.
* Build and manage the workload runner image.
* Separate workload execution from the orchestration backend.
* Support a consistent execution environment for containerized jobs.

4. Failure Detection and Recovery

* Monitor job execution and worker status.
* Identify failed or unsuccessful workloads.
* Explore recovery strategies for handling execution failures.
* Maintain job status information for monitoring and diagnosis.

5. Database Management

* Use PostgreSQL for persistent application data.
* Use Prisma ORM for database access and schema management.
* Organize job and worker information through structured database models.
* Apply database consistency mechanisms where required.

6. Monitoring and Metrics

The project is designed to explore metrics such as:

* Job waiting time.
* Job turnaround time.
* System throughput.
* Worker utilization.
* Scheduling fairness.
* Resource utilization.

The availability of these metrics depends on the implemented monitoring components.

7. Auto Scaling

OrchestrOS explores workload-based scaling to help match available processing capacity with incoming demand.

Potential scaling inputs include workload size, worker availability, and resource utilization. The actual scaling behavior depends on the implementation of the relevant modules.

🛠️ Technology Stack

Component	Technology
Frontend	React, Vite
Backend	Node.js, Express.js
Database	PostgreSQL
ORM	Prisma
Containerization	Docker
API Communication	REST APIs
Package Management	npm
Development Tools	Git, GitHub, VS Code

🏗️ Architecture

OrchestrOS follows a modular architecture in which the frontend communicates with the backend, while the backend coordinates job management and database operations.

                 ┌──────────────────────┐
                 │     React + Vite     │
                 │     Frontend         │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │    Express Backend   │
                 │   REST API Layer     │
                 └──────────┬───────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
      ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
      │ Job Manager │ │  Scheduler  │ │   Worker    │
      │             │ │             │ │  Manager    │
      └─────────────┘ └─────────────┘ └──────┬──────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │ Docker Workloads │
                                    └──────────────────┘
                 ┌──────────────────────┐
                 │      PostgreSQL      │
                 │    Prisma ORM        │
                 └──────────────────────┘

This diagram represents the intended high-level architecture. The exact interactions between modules should be verified against the current implementation.

💻 Operating System Concepts

OrchestrOS connects theoretical operating system concepts with practical workload management.

* CPU Scheduling: Exploring different strategies for deciding which job should execute next.
* Resource Allocation: Assigning workloads to workers according to available capacity.
* Process Isolation: Using containers to isolate workload execution.
* Concurrency: Coordinating multiple jobs and workers.
* Failure Handling: Detecting unsuccessful execution and managing job state.
* Load Balancing: Distributing workloads across available workers.
* Performance Evaluation: Measuring scheduling and resource utilization metrics.

🗄️ Database Management Concepts

The project also demonstrates database concepts used in a backend orchestration system.

* Relational data modeling.
* Job and worker data management.
* Database schema migrations.
* ORM-based database operations.
* Transaction management.
* Data consistency and lifecycle validation.
* Persistent storage of application state.

📂 Project Structure

The repository contains separate frontend and backend components, along with database configuration and container-related resources.

OrchestrOS/
├── frontend/             # React and Vite frontend
├── backend/              # Express backend and Prisma integration
│   └── prisma/           # Database schema and migrations
├── workload-runner/      # Containerized workload execution
├── docs/                 # Project documentation
├── compose.yaml          # Docker Compose configuration
├── .env.example          # Example environment configuration
├── package.json          # Root package configuration
└── README.md             # Project documentation

⚙️ Prerequisites

Before running the project, ensure the following tools are available:

* Git
* Node.js
* npm
* Docker Desktop or Docker Engine
* Docker Compose
* PostgreSQL configuration required by the application

🚀 Getting Started

1. Clone the Repository

git clone https://github.com/Pranjalgit1/OrchestrOS.git
cd OrchestrOS

2. Install Dependencies

npm install

If the frontend and backend require separate dependency installations, follow their respective package configurations.

3. Configure Environment Variables

Review .env.example and configure the environment variables required by your local setup.

Do not commit passwords, database credentials, API keys, or other secrets.

4. Start Docker Services

If the project’s Docker Compose configuration is ready, start the required services using:

npm run docker:up

5. Run the Application

Check the root and component-level package.json files for the available development and startup scripts.

Use the documented commands for starting the frontend and backend.

Note: The exact startup sequence may depend on database initialization and the current project configuration.

🧪 Testing

Use the test scripts defined in the root, frontend, and backend package configurations.

Typical verification areas include:

* Job creation and cancellation.
* Job lifecycle validation.
* API response handling.
* Database operations.
* Worker status management.
* Docker workload execution.
* Failure handling.
* Scheduling and resource allocation.

Only tests that exist in the repository should be described as implemented or available.

🔮 Future Enhancements

Potential areas for continued development include:

* Expanding scheduling algorithm implementations.
* Improving resource-aware worker placement.
* Enhancing failure recovery mechanisms.
* Introducing more detailed monitoring dashboards.
* Implementing workload-based autoscaling.
* Improving concurrency and database transaction handling.
* Expanding automated test coverage.
* Adding performance benchmarks for scheduling strategies.

🤝 Contributing

Contributions and suggestions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make focused changes.
4. Test your changes.
5. Commit your work with a descriptive message.
6. Open a pull request describing the changes.

📄 License

Refer to the repository’s license file for applicable usage and distribution terms.

If no license is present, consult the repository owner before redistributing or reusing the code.

👨‍💻 Project Team

OrchestrOS is being developed as an academic project to explore operating system concepts, database management, containerization, and resource-aware workload orchestration.

⸻

OrchestrOS — Exploring intelligent scheduling, container orchestration, and resource management.
